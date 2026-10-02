# Novi — Privacy Policy

_Last updated: 3 October 2026_

Novi is a personal, self-hosted AI companion. It runs on the user's own computer and is used by its developer for their own accounts. There is no Novi cloud service and no Novi company server.

## What Novi accesses

When you connect a Google account, Novi asks Google for permission to:

- **Read your Gmail** (`gmail.readonly`) — to search, list and read messages when you ask.
- **Send email as you** (`gmail.send`) — only after you approve each email on screen; Novi shows the sender account, recipients, subject and full body first.
- **See your email address** (`openid`, `email`) — to label the connected account.

Novi cannot delete, archive or modify your email.

## Where your data goes

- **Your password** is never seen or stored by Novi. You sign in on Google's own page.
- **Access tokens** are stored only on your computer, encrypted with your Windows user account (DPAPI). They are never uploaded anywhere by Novi.
- **Email content** you ask Novi about is processed on your computer and sent to one AI provider, **Groq**, to understand and answer your request. Novi does not send email content to any other AI provider. Groq's own terms apply to that processing.
- Novi keeps a short conversation history on your computer containing its spoken replies, not raw email bodies.
- Novi does not sell, share, or use your data for advertising, and does not send it to its developer.

## Your control

- Disconnect an account at any time in Novi → Settings → Accounts. This deletes the stored token and revokes it at Google.
- You can also revoke access at <https://myaccount.google.com/permissions>.
- Deleting Novi's `data/` folder removes everything Novi has stored.

## Google API Services User Data Policy

Novi's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Contact

Open an issue at <https://github.com/AaradhyAdhikari/NOVI/issues>.
