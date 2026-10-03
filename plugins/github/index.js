import { definePluginEntry } from '#plugin-sdk';
import { startDeviceFlow, pollForToken, GitHubClient, GitHubError } from './github.js';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const ACCOUNT = str('GitHub account label or login; omit to use the default or the only one');
const REPO = str('Repository: "NAME" (your own) or "owner/NAME"');
const BODY_MAX = 4000;
const COMMENT_MAX = 1000;
const WRITE_TOOLS = new Set(['github_comment', 'github_create_issue', 'github_mark_read']);

const cap = (text, max) => {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}\n… (truncated)` : s;
};

export function createGithubPlugin({ fetchImpl = fetch, sleep } = {}) {
  return definePluginEntry({
    id: 'github',
    name: 'GitHub',
    description: 'GitHub notifications, repositories, issues and pull requests; comments and new issues need approval.',
    register(api) {
      const { accounts, secrets, openUrl, speak, resolveAccount, askNote } = api.runtime;
      const clientId = api.pluginConfig.client_id;
      const privateRepos = new Map(); // "login:owner/repo" -> boolean

      // Which GitHub account a call means: { account } | { ask, note } | { error }.
      const resolve = (requested) => {
        const r = resolveAccount('github', requested);
        if (r.error) return { error: r.error };
        if (r.ask) return { ask: r.ask, note: askNote(r.ask) };
        if (r.account.status === 'expired') return { error: `Your GitHub ${r.account.label} connection expired — say "connect my GitHub" to reconnect.` };
        return { account: r.account };
      };

      const fullName = (account, repo) => {
        const name = String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '');
        if (!name) throw new Error('Tell me which repository.');
        return name.includes('/') ? name : `${account.email}/${name}`;
      };

      const call = async (account, method, path, body, what) => {
        const token = await secrets.get(account.id);
        if (!token) {
          accounts.markExpired(account.id);
          throw new Error(`Your GitHub ${account.label} connection expired — say "connect my GitHub" to reconnect.`);
        }
        try {
          return await new GitHubClient({ token, fetchImpl }).request(method, path, body);
        } catch (err) {
          if (!(err instanceof GitHubError)) throw new Error(`I couldn't reach GitHub: ${err.message}`);
          if (err.status === 401) {
            accounts.markExpired(account.id);
            throw new Error(`Your GitHub ${account.label} connection expired — say "connect my GitHub" to reconnect.`);
          }
          if (err.status === 404) throw new Error(`I couldn't find ${what || 'that'} on GitHub (or this account can't see it).`);
          if (err.status === 403) throw new Error(`GitHub refused that request: ${err.message}`);
          throw new Error(`GitHub had a problem: ${err.message}`);
        }
      };

      const isPrivate = async (account, full) => {
        const key = `${account.id}:${full.toLowerCase()}`;
        if (!privateRepos.has(key)) privateRepos.set(key, Boolean((await call(account, 'GET', `/repos/${full}`, undefined, full)).private));
        return privateRepos.get(key);
      };

      const readTool = (spec) => api.registerTool({
        ...spec,
        async execute(_id, params) {
          const r = resolve(params.account);
          if (r.error) throw new Error(r.error);
          if (r.ask) return { content: [], details: { ask: r.ask, note: r.note } };
          return { content: [], details: await spec.run(r.account, params) };
        },
      });

      api.registerTool({
        name: 'github_connect',
        description: "Connect a GitHub account: shows a short code and opens github.com/login/device on the laptop, where the user enters it and authorizes Novi.",
        parameters: obj(),
        async execute() {
          if (!clientId) {
            const error = "GitHub isn't set up yet: add NOVI_PLUGIN_GITHUB_CLIENT_ID (your GitHub OAuth app's Client ID, with Device Flow enabled) to Novi's .env and restart Novi.";
            return { content: [], details: { error, note: error } };
          }
          const flow = await startDeviceFlow({ clientId, fetchImpl });
          await openUrl(flow.verification_uri);
          (async () => {
            const { token, scope } = await pollForToken({ clientId, deviceCode: flow.device_code, interval: flow.interval, expiresIn: flow.expires_in, fetchImpl, ...(sleep ? { sleep } : {}) });
            const user = await new GitHubClient({ token, fetchImpl }).request('GET', '/user');
            const account = accounts.add({ provider: 'github', email: user.login, scopes: scope.split(/[\s,]+/).filter(Boolean) });
            try {
              await secrets.set(account.id, token);
            } catch (err) {
              accounts.remove(account.id);
              throw new Error(`I couldn't store the GitHub key securely: ${err.message}`);
            }
            speak(`GitHub connected as ${account.email}.`);
          })().catch((err) => speak(err.message));
          const spaced = flow.user_code.split('').join(' ');
          return {
            content: [],
            details: {
              user_code: flow.user_code,
              verification_uri: flow.verification_uri,
              note: `I've opened github.com/login/device on the laptop. Enter the code ${flow.user_code} (${spaced}) and click Authorize. I'll tell you when it's connected.`,
            },
          };
        },
      });

      readTool({
        name: 'github_notifications',
        description: 'List GitHub notifications (unread by default).',
        parameters: obj({ all: { type: 'boolean', description: 'Include read notifications' }, account: ACCOUNT }),
        run: async (account, { all = false }) => {
          const list = await call(account, 'GET', `/notifications?per_page=20&all=${Boolean(all)}`);
          return {
            account: account.label,
            sensitive: list.some((n) => n.repository?.private),
            notifications: list.map((n) => ({ id: n.id, repo: n.repository?.full_name, title: n.subject?.title, type: n.subject?.type, reason: n.reason, unread: n.unread, updated: n.updated_at })),
          };
        },
      });

      readTool({
        name: 'github_repos',
        description: "List the user's repositories, most recently updated first.",
        parameters: obj({ account: ACCOUNT }),
        run: async (account) => {
          const list = await call(account, 'GET', '/user/repos?sort=updated&per_page=20');
          return {
            account: account.label,
            sensitive: list.some((r) => r.private),
            repos: list.map((r) => ({ name: r.full_name, private: r.private, description: r.description, open_issues: r.open_issues_count, updated: r.pushed_at })),
          };
        },
      });

      readTool({
        name: 'github_issues',
        description: 'List issues and/or pull requests in a repository.',
        parameters: obj({ repo: REPO, state: str('"open" (default), "closed" or "all"'), type: str('"all" (default), "issues" or "pulls"'), account: ACCOUNT }, ['repo']),
        run: async (account, { repo, state = 'open', type = 'all' }) => {
          const full = fullName(account, repo);
          const sensitive = await isPrivate(account, full);
          const list = await call(account, 'GET', `/repos/${full}/issues?state=${encodeURIComponent(state)}&per_page=20`, undefined, full);
          const items = list
            .filter((i) => (type === 'issues' ? !i.pull_request : type === 'pulls' ? Boolean(i.pull_request) : true))
            .map((i) => ({ number: i.number, title: i.title, kind: i.pull_request ? 'pull request' : 'issue', state: i.state, author: i.user?.login, comments: i.comments, updated: i.updated_at }));
          return { account: account.label, repo: full, sensitive, items };
        },
      });

      readTool({
        name: 'github_read',
        description: 'Read one issue or pull request with its recent comments.',
        parameters: obj({ repo: REPO, number: { type: 'integer', description: 'Issue or pull request number' }, account: ACCOUNT }, ['repo', 'number']),
        run: async (account, { repo, number }) => {
          const full = fullName(account, repo);
          const sensitive = await isPrivate(account, full);
          const issue = await call(account, 'GET', `/repos/${full}/issues/${Number(number)}`, undefined, `${full}#${number}`);
          const comments = await call(account, 'GET', `/repos/${full}/issues/${Number(number)}/comments?per_page=20`, undefined, `${full}#${number}`);
          return {
            account: account.label,
            repo: full,
            sensitive,
            item: {
              number: issue.number,
              title: issue.title,
              kind: issue.pull_request ? 'pull request' : 'issue',
              state: issue.state,
              author: issue.user?.login,
              body: cap(issue.body, BODY_MAX),
              comments: comments.map((c) => ({ author: c.user?.login, body: cap(c.body, COMMENT_MAX), created: c.created_at })),
            },
          };
        },
      });

      const writeTool = (spec) => api.registerTool({
        ...spec,
        async execute(_id, params) {
          const r = resolve(params.account);
          if (!r.account) throw new Error(r.error || r.note);
          return { content: [], details: await spec.run(r.account, params) };
        },
      });

      writeTool({
        name: 'github_comment',
        description: 'Comment on an issue or pull request. The user sees the full comment and must approve it.',
        parameters: obj({ repo: REPO, number: { type: 'integer' }, body: str('The complete comment (Markdown allowed)'), account: ACCOUNT }, ['repo', 'number', 'body']),
        run: async (account, { repo, number, body }) => {
          const full = fullName(account, repo);
          const res = await call(account, 'POST', `/repos/${full}/issues/${Number(number)}/comments`, { body }, `${full}#${number}`);
          return { commented: true, url: res.html_url };
        },
      });

      writeTool({
        name: 'github_create_issue',
        description: 'Open a new issue in a repository. The user sees the title and body and must approve it.',
        parameters: obj({ repo: REPO, title: str('Issue title'), body: str('Issue description (Markdown allowed)'), account: ACCOUNT }, ['repo', 'title']),
        run: async (account, { repo, title, body = '' }) => {
          const full = fullName(account, repo);
          const res = await call(account, 'POST', `/repos/${full}/issues`, { title, body }, full);
          return { created: res.number, url: res.html_url };
        },
      });

      writeTool({
        name: 'github_mark_read',
        description: 'Mark GitHub notifications as read: one thread (thread_id from github_notifications) or all of them.',
        parameters: obj({ thread_id: str('Notification id; omit for all'), account: ACCOUNT }),
        run: async (account, { thread_id: threadId }) => {
          if (threadId) {
            await call(account, 'PATCH', `/notifications/threads/${encodeURIComponent(threadId)}`, undefined, 'that notification');
            return { marked: threadId };
          }
          await call(account, 'PUT', '/notifications', { read: true });
          return { marked: 'all' };
        },
      });

      // Everything that writes to GitHub needs the user's approval (Novi "medium").
      api.on('before_tool_call', ({ toolName, params }) => {
        if (!WRITE_TOOLS.has(toolName)) return undefined;
        const r = resolve(params.account);
        if (!r.account) return { block: true, blockReason: r.error || r.note, details: r.ask ? { ask: r.ask, note: r.note } : { error: r.error } };
        const who = r.account.email;
        let full;
        try {
          full = toolName === 'github_mark_read' ? null : fullName(r.account, params.repo);
        } catch (err) {
          return { block: true, blockReason: err.message };
        }
        if (toolName === 'github_comment') return { requireApproval: { title: `Comment on ${full}#${params.number} as ${who}`, description: String(params.body || ''), severity: 'warning' } };
        if (toolName === 'github_create_issue') return { requireApproval: { title: `Open an issue on ${full} as ${who}: ${params.title}`, description: String(params.body || ''), severity: 'warning' } };
        return { requireApproval: { title: params.thread_id ? `Mark one GitHub notification as read (${who})` : `Mark all GitHub notifications as read (${who})`, description: '', severity: 'warning' } };
      });
    },
  });
}

export default createGithubPlugin();
