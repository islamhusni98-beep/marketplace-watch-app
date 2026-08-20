const MARKETPLACE_URL = 'https://www.facebook.com/marketplace/giza/search?maxPrice=1000000&itemCondition=new&query=toyota%20corolla%202022&exact=false';

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

  const diagnostics = {
    hasAccountId: Boolean(accountId),
    hasApiToken: Boolean(apiToken),
    accountIdLength: accountId?.length ?? 0,
    apiTokenLength: apiToken?.length ?? 0,
    vercelEnv: process.env.VERCEL_ENV ?? null,
    vercelRegion: process.env.VERCEL_REGION ?? null,
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  };

  if (!accountId || !apiToken) {
    return res.status(500).json({
      ok: false,
      error: 'Missing Cloudflare environment variables',
      diagnostics,
    });
  }

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  try {
    const [linksResponse, markdownResponse] = await Promise.all([
      fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/links`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            url: MARKETPLACE_URL,
            gotoOptions: { waitUntil: 'networkidle2' },
            excludeExternalLinks: true,
          }),
        },
      ),
      fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/markdown`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            url: MARKETPLACE_URL,
            gotoOptions: { waitUntil: 'networkidle2' },
          }),
        },
      ),
    ]);

    const linksData = await linksResponse.json();
    const markdownData = await markdownResponse.json();

    const links = Array.isArray((linksData as { result?: unknown }).result)
      ? ((linksData as { result: string[] }).result ?? [])
      : [];

    const marketplaceItems = links.filter((url) =>
      url.includes('/marketplace/item/'),
    );

    const markdownResult = (markdownData as { result?: unknown }).result;
    const pageText =
      typeof markdownResult === 'string'
        ? markdownResult
        : JSON.stringify(markdownResult ?? '');

    const textLower = pageText.toLowerCase();
    const loginWallDetected =
      textLower.includes('log in') ||
      textLower.includes('login') ||
      textLower.includes('create new account');

    return res.status(linksResponse.ok ? 200 : linksResponse.status).json({
      ok: linksResponse.ok,
      diagnostics,
      cloudflareStatus: linksResponse.status,
      markdownStatus: markdownResponse.status,
      totalLinks: links.length,
      sampleLinks: links.slice(0, 30),
      marketplaceItemCount: marketplaceItems.length,
      marketplaceItems: marketplaceItems.slice(0, 20),
      loginWallDetected,
      pageTextPreview: pageText.slice(0, 3000),
      rawSuccess: (linksData as { success?: boolean }).success ?? null,
      markdownSuccess: (markdownData as { success?: boolean }).success ?? null,
      errors: (linksData as { errors?: unknown }).errors ?? null,
      markdownErrors: (markdownData as { errors?: unknown }).errors ?? null,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      diagnostics,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
