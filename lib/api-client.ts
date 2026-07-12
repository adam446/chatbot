const baseUrl = process.env.API_BASE_URL ?? "";

export function createApiClient(token: string, _baseUrl: string = baseUrl) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  // TODO: replace placeholder methods with real API endpoints
  return {
    async get(path: string) {
      const response = await fetch(`${_baseUrl}${path}`, { headers });
      return response.json();
    },

    async post(path: string, body: unknown) {
      const response = await fetch(`${_baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      return response.json();
    },
  };
}