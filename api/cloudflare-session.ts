const MARKETPLACE_URL = 'https://www.facebook.com/marketplace/giza/search?maxPrice=1000000&query=toyota%20corolla%202022&exact=false';

type Target = {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  devtoolsFrontendUrl?: string;
  webSocketDebuggerUrl?: string;
};

function toFullLiveView(url: string | null) {
  if (!url) return null;
  if (url.includes('/ui/inspector?wss=')) {
    return url.replace('/ui/inspector?wss=', '/ui/view?mode=full&wss=');
  }
  if (url.includes('/ui/view?wss=')) {
    return url.replace('/ui/view?wss=', '/ui/view?mode=full&wss=');
  }
  return url;
}

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
    const sessionResponse = await fetch(`${base}?keep_alive=600000&targets=true`, {
      method: 'POST',
      headers,
    });
    const sessionData = await sessionResponse.json() as {
      sessionId?: string;
      targets?: Target[];
      result?: { sessionId?: string; targets?: Target[] };
    };

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

    const newTabResponse = await fetch(
      `${base}/${sessionId}/json/new?${new URLSearchParams({ url: MARKETPLACE_URL }).toString()}`,
      { method: 'PUT', headers },
    );
    const newTabData = await newTabResponse.json() as Target & { result?: Target };
    const createdTarget = newTabData.result ?? newTabData;

    let target: Target | null = createdTarget?.id ? createdTarget : null;

    if (!target?.devtoolsFrontendUrl) {
      const listResponse = await fetch(`${base}/${sessionId}/json/list`, { headers });
      const listData = await listResponse.json() as unknown;
      const listPayload =
        typeof listData === 'object' && listData !== null && 'result' in listData
          ? (listData as { result?: unknown }).result
          : listData;
      const targets = Array.isArray(listPayload) ? (listPayload as Target[]) : [];
      target =
        targets.find((item) => item.type === 'page' && item.url?.includes('facebook.com')) ??
        targets.find((item) => item.type === 'page') ??
        null;
    }

    const devtoolsFrontendUrl = target?.devtoolsFrontendUrl ?? null;
    const liveViewUrl = toFullLiveView(devtoolsFrontendUrl);

    return res.status(200).json({
      ok: true,
      sessionId,
      keepAliveMs: 600000,
      target: target
        ? {
            id: target.id ?? null,
            title: target.title ?? null,
            url: target.url ?? null,
          }
        : null,
      liveViewUrl,
      devtoolsFrontendUrl,
      note: 'Open liveViewUrl immediately. It uses Cloudflare full Live View mode and the browser session stays alive up to 10 minutes of inactivity.',
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
