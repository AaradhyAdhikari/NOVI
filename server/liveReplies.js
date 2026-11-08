// A turn from the phone watching the remote view (plugins/live-screen) shows on the view only: its words and
// Novi's reply stay out of the chat, and the reply ("Opened Spotify.", "Scrolled down.") is the view's line
// (user, 2026-11-08: "hide all those commands", "it should be telling me what it did").
export function replyPlace({ from = 'local', viewing = false } = {}) {
  return from !== 'local' && viewing ? 'view' : 'chat';
}
