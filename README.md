# Ask Copper

A Copper State Labs help page where customers ask questions and get answers from the four
support PDFs, each with the page it came from.

## Files
- `index.html` – the Ask Copper page
- `api/ask.js` – the serverless function Vercel runs at `/api/ask`
- `pages.js` – the text of every page of the four PDFs, numbered to match the PDFs
- `package.json` – tells Vercel to use modern JavaScript modules

## Deploy to Vercel
1. Create a new GitHub repository and upload all of these files (keep the `api` folder).
2. On vercel.com, choose **Add New > Project**, import the repository, leave the
   Framework Preset on **Other**, and click **Deploy**.
3. To have Claude write the answers, open the project's **Settings > Environment Variables**,
   add `ANTHROPIC_API_KEY` with your key, then go to **Deployments** and **Redeploy**.
   Optional: set `ANTHROPIC_MODEL` to use a different Claude model.

Without an API key the site still works using a simpler keyword search over the same pages.
Each answer shows which mode answered it.
