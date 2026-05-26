// Slack incoming-webhook notifier. Used by Phase E's PO approval gate.
//
// The webhook URL is created in Slack (per-channel, per-product) and
// pasted into products.slack_webhook_url. We POST a JSON body with the
// message text + optional rich blocks; Slack delivers it to the channel.
//
// No app, no OAuth, no signing — just an HTTPS POST to a URL Slack
// considers secret. Treat the URL as a secret in DDB (it grants
// unauthenticated post-to-channel privileges).
//
// Best-effort: a non-2xx response logs but doesn't throw. The PO's
// recommend-merge comment on the issue is the load-bearing artifact;
// Slack is the notification overlay.

export type SlackBlock = Record<string, unknown>;

export type SlackMessage = {
  // Fallback text shown in mobile previews / when blocks can't render.
  text: string;
  // Slack Block Kit blocks for rich rendering. Optional; plain text is
  // fine on its own.
  blocks?: SlackBlock[];
};

export type SlackNotifyResult =
  | { ok: true; status: number }
  | { ok: false; status: number; body: string }
  | { ok: false; status: 0; body: string };

export async function notifySlack(
  webhookUrl: string,
  message: SlackMessage,
): Promise<SlackNotifyResult> {
  try {
    const r = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    if (r.ok) return { ok: true, status: r.status };
    const body = await r.text().catch(() => "");
    return { ok: false, status: r.status, body: body.slice(0, 500) };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: err instanceof Error ? err.message : String(err),
    };
  }
}

// ----------------------------------------------------------------------------
// Gate helpers (pure)
// ----------------------------------------------------------------------------

// Whether the approval gate is currently active for this product.
// `approvalGateUntil` is an ISO timestamp; gate is active when now < that.
// Missing / malformed = gate inactive (no gate configured).
export function isGateActive(
  approvalGateUntil: string | undefined,
  now: Date = new Date(),
): boolean {
  if (!approvalGateUntil) return false;
  const ts = Date.parse(approvalGateUntil);
  if (Number.isNaN(ts)) return false;
  return now.getTime() < ts;
}
