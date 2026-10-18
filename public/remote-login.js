const $ = (id) => document.getElementById(id);
async function checkSession() {
  try {
    const response = await fetch("/remote-api/session", { credentials: "same-origin", cache: "no-store" });
    if (response.ok) window.location.replace("/app");
  } catch {
    // An offline gateway leaves the pairing form available for retry.
  }
}
document.getElementById("pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("error").textContent = "";
  $("pair-button").disabled = true;
  try {
    const response = await fetch("/remote-api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ code: $("code").value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "연결에 실패했어요.");
    window.location.replace("/app");
  } catch (error) {
    $("error").textContent = error.message;
    $("pair-button").disabled = false;
  }
});
void checkSession();
