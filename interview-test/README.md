# Interview Test

A locked-down online test with an admin panel.

- **Candidate link:** `https://YOUR-APP.up.railway.app/`
- **Admin panel:** `https://YOUR-APP.up.railway.app/admin`

When a candidate submits, three things happen. They download a PDF copy of their answers, which leaves out the answer key and the score. The test then closes for them. And the admin receives an email with the full PDF report plus any files the candidate attached. Every result is also kept in the admin panel.

## Deploy on Railway

1. **Put the code on GitHub.** Create a new repository and upload everything in this folder.
2. **Create the service.** On railway.com, choose **New Project**, then **Deploy from GitHub repo**, and pick your repository. Railway detects Node.js and runs `npm start`.
3. **Add a Volume.** This step is required, otherwise all results are lost on every redeploy. Right-click the service, choose **Attach Volume**, and set the mount path to `/data`.
4. **Add Variables** in the service's **Variables** tab:

   | Variable | Value |
   |---|---|
   | `ADMIN_PASSWORD` | a strong password for `/admin` |
   | `ADMIN_EMAIL` | `anzal@iconic.bh` |
   | `DATA_DIR` | `/data` |
   | `RESEND_API_KEY` | your Resend key (see Email below) |
   | `MAIL_FROM` | e.g. `Interview Test <tests@iconic.bh>` |

5. **Create a public link.** Go to **Settings**, then **Networking**, then **Generate Domain**.
6. **Set up the test.** Open `/admin`, sign in, add your questions, and use **Settings** to send a test email. Then send candidates the main link.

## Email

Railway blocks outgoing SMTP on some plans, so the app uses **Resend** by default. Resend sends email over HTTPS and has a free tier.

1. Sign up at resend.com and create an API key.
2. Verify your sending domain (e.g. `iconic.bh`) under **Domains**. Until you do, Resend only delivers to the email address you signed up with.
3. Put the key in `RESEND_API_KEY` and a matching address in `MAIL_FROM`.

If you'd rather use SMTP (Gmail app password, Outlook, Zoho, etc.) and your Railway plan allows it, leave `RESEND_API_KEY` empty and set `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER` and `SMTP_PASS` instead.

If an email fails, the result is still saved. The admin panel shows **Email not sent** on that result and has a **Resend email** button.

## Run locally

```bash
npm install
ADMIN_PASSWORD=secret npm start      # http://localhost:3000 and /admin
```

## Notes

- **One attempt per email address.** Deleting a result in the admin panel lets that person retake the test.
- **File uploads** are limited to 10 MB per file.
- **Limits of browser lockdown.** A web page can't completely stop someone closing a tab or quitting the browser. The lockdown blocks, warns against and records these actions, so treat it as a deterrent plus an audit log.
- **PDF text.** The PDFs use a built-in Latin font, so Arabic text in questions or answers won't display correctly in the PDF, although it shows fine in the admin panel.
