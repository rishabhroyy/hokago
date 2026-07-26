import { createHokagoClient } from "@hokago/contract/client";

export const api: ReturnType<typeof createHokagoClient> = createHokagoClient("");

api.use({
  onRequest({ request }) {
    const token = localStorage.getItem("hokago_access_token");
    if (token) request.headers.set("Authorization", `Bearer ${token}`);
    return request;
  },
});
