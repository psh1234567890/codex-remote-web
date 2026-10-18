import { fileURLToPath } from "node:url";
import { issuePairingCode } from "../server/remote-auth.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const result = issuePairingCode(root);
console.log("One-time Safari pairing code (expires after 10 minutes):");
console.log(result.code);
console.log("Enter this code only into your Safari login page. Do not share it.");
