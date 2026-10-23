# Email delivery setup

The NIRS web app stores saved sessions in the browser's local storage. Email delivery is a separate optional feature implemented with a Netlify Function and the Resend email API.

## Required Netlify deployment

A static drag-and-drop deploy of `apps/web/dist` publishes only the frontend and does **not** publish serverless functions. Deploy this repository through Netlify's Git integration, or use the Netlify CLI to deploy both the site and the `netlify/functions` directory. The repository includes `netlify.toml` with the build and function paths.

## Configure email

1. Create a Resend account at https://resend.com/ and verify a sender domain/address according to Resend's instructions.
2. In Netlify, open **Site configuration → Environment variables** (wording may vary) and add:
   - `RESEND_API_KEY`: secret API key from Resend. Keep this server-side; never add it to frontend code or commit it to Git.
   - `NIRS_EMAIL_FROM`: a sender identity allowed by your Resend account, for example `NIRS Console <nirs@your-verified-domain.example>` (replace with your real verified sender).
   - `NIRS_ALLOWED_RECIPIENTS`: comma-separated allowlist of recipient addresses permitted to receive reports, for example `researcher@example.com,client@example.com`.
3. Redeploy the site after setting variables so the function receives the configuration.
4. In **Analyze & Export → Email delivery**, enter an address that appears in the approved recipient allowlist. Enable **Automatically email when I finish a session** if desired.
5. Click **Finish session & send report** (or **Finish session** if auto-email is disabled, then **Send report now**). The processed CSV is attached to the email.

## Important behavior and privacy

- Automatic delivery occurs when the user explicitly clicks **Finish session**; the app does not infer when an ongoing sensor stream is finished.
- Email is sent by the Netlify server-side function. The Resend API key is never sent to the browser.
- Only addresses in `NIRS_ALLOWED_RECIPIENTS` are accepted, to reduce abuse of the public endpoint.
- The function rejects CSV attachments larger than 4 MiB.
- Browser session history remains local to that browser unless separately exported; emailing a CSV does not create a cloud database or synchronize session history.
- Confirm participant consent, recipient authorization, and institutional data-handling requirements before emailing research recordings. Avoid sending direct identifiers or sensitive participant information by ordinary email.
- A successful provider response means Resend accepted the message for delivery; it does not guarantee the recipient's inbox received it.
