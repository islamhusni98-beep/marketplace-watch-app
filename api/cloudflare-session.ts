const MARKETPLACE_URL = 'https://www.facebook.com/marketplace/giza/search?maxPrice=1000000&query=toyota%20corolla%202022&exact=false';

export default async function handler(
  _req: unknown,
  res: {
    status: (code: number) => {
      json: (body: unknown) => void;
    };
  }
) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    return res.status(500).json({ ok: false, error: 'Missing Cloudflare environment variables' });
  }

  const headers = { Authorization: `Bearer ${apiToken}` };
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/devtools/browser`;

  try {
    const sessionResponse = await fetch(`${base}?keep_alive=600000`, {
      method: 'POST',
      headers,
    });
    const sessionData = await sessionResponse.json();

    const sessionId = (sessionData as { result?: { sessionId?: string } }).result?.sessionId;
    if (!sessionResponse.ok || !sessionId) {
      return res.status(sessionResponse.status || 500).json({
        ok: false,
        step: 'create-session',
        cloudflareStatus: sessionResponse.status,
        response: sessionData,
      });
    }

    const newTabResponse = await fetch(
      `${base}/${sessionId}/json/new?${new URLSearchParams({ url: MARKETPLACE_URL }).toString()}`,
      { method: 'PUT', headers },
    );
    const newTabData = await newTabResponse.json();

    const listResponse = await fetch(`${base}/${sessionId}/json/list`, { headers });
    const listData = await listResponse.json();

    const targets = Array.isArray((listData as { result?: unknown }).result)
      ? ((listData as { result: Array<Record<string, unknown>> }).result ?? [])
      : Array.isArray(listData)
        ? (listData as Array<Record<string, unknown>>)
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
      openMarketplaceResponse: newTabData,
      targetCount: targets.length,
      target: preferredTarget
        ? {
            id: preferredTarget.id ?? null,
            title: preferredTarget.title ?? null,
            url: preferredTarget.url ?? null,
            devtoolsFrontendUrl,
          }
        : null,
      instructions: devtoolsFrontendUrl
        ? 'Open devtoolsFrontendUrl immediately, log in to Facebook, and keep the session active.'
        : 'No Live View URL was returned. Open Cloudflare Browser Run > Live Sessions and open this session manually.',
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
