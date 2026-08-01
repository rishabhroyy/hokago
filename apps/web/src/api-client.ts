import { createHokagoClient } from "@hokago/contract/client";

export const api: ReturnType<typeof createHokagoClient> = createHokagoClient("");

api.use({
  onRequest({ request }) {
    const token = localStorage.getItem("hokago_access_token");
    if (token) request.headers.set("Authorization", `Bearer ${token}`);
    return request;
  },
  onResponse({ request, response }) {
    // Expired/invalid token on any authenticated endpoint → drop it and send
    // the user to the login gate instead of rendering a silent empty app.
    if (response.status === 401 && !request.url.includes("/auth/")) {
      localStorage.removeItem("hokago_access_token");
      if (location.pathname !== "/login") location.assign("/login");
    }
    return response;
  },
});
