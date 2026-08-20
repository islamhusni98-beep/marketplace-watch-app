export default async function handler(
  _req: unknown,
  res: { status: (code: number) => { json: (body: unknown) => void } },
) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    return res.status(500).json({
      ok: false,
      error: 'Missing Cloudflare environment variables',
    });
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/devtools/browser?keep_alive=600000&targets=true&liveViewUrlExpiresInMs=600000`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    const raw = await response.text();
    let data: unknown = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      return res.status(response.status || 500).json({
        ok: false,
        step: 'create-session',
        cloudflareStatus: response.status,
        rateLimited: response.status === 429,
        retryAfter: response.headers.get('retry-after'),
        responseText: raw.slice(0, 300),
      });
    }

    const typed = (data ?? {}) as {
      sessionId?: string;
      webSocketDebuggerUrl?: string;
      targets?: Array<{
        id?: string;
        type?: string;
        title?: string;
        url?: string;
        devtoolsFrontendUrl?: string;
        webSocketDebuggerUrl?: string;
      }>;
      result?: {
        sessionId?: string;
        webSocketDebuggerUrl?: string;
        targets?: Array<{
          id?: string;
          type?: string;
          title?: string;
          url?: string;
          devtoolsFrontendUrl?: string;
          webSocketDebuggerUrl?: string;
        }>;
      };
    };

    const payload = typed.result ?? typed;
    const sessionId = payload.sessionId;
    const targets = Array.isArray(payload.targets) ? payload.targets : [];
    const target = targets.find((item) => item.type === 'page') ?? targets[0] ?? null;
    const liveViewUrl = target?.devtoolsFrontendUrl ?? null;

    if (!sessionId || !liveViewUrl) {
      return res.status(502).json({
        ok: false,
        step: 'parse-session',
        sessionId: sessionId ?? null,
        targetCount: targets.length,
        response: data,
      });
    }

    return res.status(200).json({
      ok: true,
      sessionId,
      keepAliveMs: 600000,
      target: {
        id: target?.id ?? null,
        title: target?.title ?? null,
        url: target?.url ?? null,
      },
      liveViewUrl,
      instructions:
        'Open liveViewUrl immediately. The session starts on about:blank; navigate manually to facebook.com, log in, then open Marketplace.',
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
