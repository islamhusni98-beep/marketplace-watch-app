const MARKETPLACE_URL = 'https://www.facebook.com/marketplace/giza/search?maxPrice=1000000&query=toyota%20corolla%202022&exact=false';

export default async function handler(
  _req: unknown,
  res: { status: (code: number) => { json: (body: unknown) => void } },
) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    return res.status(500).json({ ok: false, error: 'Missing Cloudflare environment variables' });
  }

  const headers = { Authorization: `Bearer ${apiToken}` };
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/devtools/browser`;

  try {
    // targets=true asks Cloudflare to return an immediately usable Live View URL.
    const sessionResponse = await fetch(
      `${base}?keep_alive=600000&targets=true&liveViewUrlExpiresInMs=600000`,
      { method: 'POST', headers },
    );
    const sessionData = await sessionResponse.json() as {
      sessionId?: string;
      webSocketDebuggerUrl?: string;
      targets?: Array<Record<string, unknown>>;
      result?: {
        sessionId?: string;
        webSocketDebuggerUrl?: string;
        targets?: Array<Record<string, unknown>>;
      };
    };

    // Browser Run's CDP endpoint returns the object directly. Keep result fallback
    // for compatibility with older envelope-style responses.
    const payload = sessionData.result ?? sessionData;
    const sessionId = payload.sessionId;

    if (!sessionResponse.ok || !sessionId) {
      return res.status(sessionResponse.status || 500).json({
        ok: false,
        step: 'create-session',
        cloudflareStatus: sessionResponse.status,
        response: sessionData,
      });
    }

    // Open Marketplace in this same persistent browser session.
    const newTabResponse = await fetch(
      `${base}/${sessionId}/json/new?${new URLSearchParams({ url: MARKETPLACE_URL }).toString()}`,
      { method: 'PUT', headers },
    );
    const newTabData = await newTabResponse.json() as Record<string, unknown>;

    // The HTTP CDP tab endpoints return target objects/arrays directly.
    const listResponse = await fetch(`${base}/${sessionId}/json/list`, { headers });
    const listData = await listResponse.json() as unknown;
    const listPayload =
      typeof listData === 'object' && listData !== null && 'result' in listData
        ? (listData as { result?: unknown }).result
        : listData;
    const targets = Array.isArray(listPayload)
      ? (listPayload as Array<Record<string, unknown>>)
      : [];

    const pageTargets = targets.filter((target) => target.type === 'page');
    const preferredTarget =
      pageTargets.find((target) => typeof target.url === 'string' && target.url.includes('facebook.com')) ??
      pageTargets[0] ??
      null;

    const devtoolsFrontendUrl =
      preferredTarget && typeof preferredTarget.devtoolsFrontendUrl === 'string'
        ? preferredTarget.devtoolsFrontendUrl
        : null;

    return res.status(200).json({
      ok: true,
      sessionId,
      keepAliveMs: 600000,
      openMarketplaceStatus: newTabResponse.status,
      targetCount: targets.length,
      target: preferredTarget
        ? {
            id: preferredTarget.id ?? null,
            title: preferredTarget.title ?? null,
            url: preferredTarget.url ?? null,
            devtoolsFrontendUrl,
          }
        : null,
      devtoolsFrontendUrl,
      instructions: devtoolsFrontendUrl
        ? 'Open devtoolsFrontendUrl immediately. Log in to Facebook and open Marketplace before the 10-minute session expires.'
        : 'Session was created but no Live View target URL was returned.',
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
