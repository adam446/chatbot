import { initBotId } from "botid/client/core";

if (process.env.NEXT_PUBLIC_BOTID_ENABLED === "1") {
  initBotId({
    protect: [
      {
        method: "POST",
        path: "/api/chat",
      },
    ],
  });
}
