// ponytail: placeholder entrypoint so the compose service boots — real BullMQ
// consumer + reconciler land in §19 Step 3 (job infrastructure). Same image as
// apps/api, different entrypoint (§6.1).
console.log("hokago-worker: up, waiting for job infrastructure (§19 Step 3)");
setInterval(() => {}, 1 << 30);
