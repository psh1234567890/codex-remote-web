import { fileURLToPath } from "node:url";
import { issuePairingCode } from "../server/remote-auth.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const endpoint = process.env.REMOTE_TEST_URL;
if (!endpoint || !/^https:\/\/[-.a-z0-9]+\.ts\.net:10000\/$/.test(endpoint)) {
  console.error("Set REMOTE_TEST_URL to the official HTTPS Funnel URL ending in :10000/");
  process.exitCode = 1;
} else {
  const code = issuePairingCode(root).code;
  const origin = new URL(endpoint).origin;
  let cookie;
  try {
    const unauthenticated = await fetch(endpoint + "api/threads");
    if (unauthenticated.status !== 401) throw new Error("Unauthenticated API access not blocked");
    const paired = await fetch(endpoint + "remote-api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ code }),
    });
    if (paired.status !== 200) throw new Error("Pairing failed: HTTP " + paired.status);
    const setCookie = paired.headers.get("set-cookie");
    if (!setCookie?.includes("HttpOnly") || !setCookie.includes("Secure")) throw new Error("Secure session cookie missing");
    cookie = setCookie.split(";")[0];
    const app = await fetch(endpoint + "app", { headers: { Cookie: cookie } });
    if (app.status !== 200 || !(await app.text()).includes("Codex Remote Web")) {
      throw new Error("Authenticated app access failed");
    }
    const projects = await fetch(endpoint + "api/projects", { headers: { Cookie: cookie } });
    if (projects.status !== 200) throw new Error("Project permissions endpoint unavailable");
    const list = (await projects.json()).projects;
    if (!Array.isArray(list) || !list.length) throw new Error("No project permissions available");
    const deniedPermission = await fetch(endpoint + "api/projects/" + list[0].id + "/access", {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "X-Remote-Client": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, managementKey: "0".repeat(64) }),
    });
    if (deniedPermission.status !== 403) throw new Error("Wrong management key was not rejected");
    const threads = await fetch(endpoint + "api/threads", { headers: { Cookie: cookie } });
    if (threads.status !== 200) throw new Error("Authenticated API proxy failed: HTTP " + threads.status);
    const logout = await fetch(endpoint + "remote-api/logout", {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin },
    });
    if (logout.status !== 200) throw new Error("Logout failed");
    const revoked = await fetch(endpoint + "api/threads", { headers: { Cookie: cookie } });
    if (revoked.status !== 401) throw new Error("Revoked session still accepted");
    console.log("Public HTTPS login, API protection, pairing, app access, Codex proxy and logout: OK");
    console.log("No pairing codes or session secrets were printed.");
  } catch (error) {
    console.error("Public smoke test failed:", error.message);
    process.exitCode = 1;
    if (cookie) {
      try {
        await fetch(endpoint + "remote-api/logout", {
          method: "POST",
          headers: { Cookie: cookie, Origin: origin },
        });
      } catch {}
    }
  }
}
