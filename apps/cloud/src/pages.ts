/** The few pages a person sees in their browser: after signing in, and to reset a password. */

function escape(text: string) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Memories</title>
<style>
  :root { color-scheme: light dark; --bg: #fbfbfd; --card: #fff; --text: #1c1c1e; --muted: #6e6e73; --accent: #0a84ff; --line: #e5e5ea; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1c1c1e; --card: #2c2c2e; --text: #f2f2f7; --muted: #a1a1a6; --line: #3a3a3c; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text);
    font: 16px/1.5 "Atkinson Hyperlegible", system-ui, sans-serif; padding: 16px; box-sizing: border-box; }
  main { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 32px; max-width: 380px; width: 100%; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: var(--muted); margin: 0 0 16px; }
  label { display: block; font-weight: 700; margin: 16px 0 6px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line);
    background: transparent; color: inherit; font: inherit; }
  button { margin-top: 20px; width: 100%; padding: 12px; border: 0; border-radius: 10px; background: var(--accent);
    color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
  #status { margin-top: 12px; min-height: 1.5em; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function messagePage(title: string, message: string) {
  return page(title, `<h1>${escape(title)}</h1><p>${escape(message)}</p>`);
}

export function resetPasswordPage(token: string) {
  return page(
    "Choose a new password",
    `<h1>Choose a new password</h1>
<p>Use at least 10 characters.</p>
<form id="reset">
  <label for="password">New password</label>
  <input id="password" type="password" autocomplete="new-password" minlength="10" required>
  <button type="submit">Save password</button>
  <p id="status" role="status"></p>
</form>
<script>
  const token = ${JSON.stringify(token).replace(/</g, "\\u003c")};
  document.getElementById("reset").addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = document.getElementById("status");
    status.textContent = "Saving…";
    const response = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newPassword: document.getElementById("password").value, token }),
    });
    status.textContent = response.ok
      ? "Saved. Go back to Memories and sign in with your new password."
      : "That didn't work. The link may have expired; ask for a new one in Memories.";
  });
</script>`,
  );
}
