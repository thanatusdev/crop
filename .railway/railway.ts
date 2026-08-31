import { defineRailway, postgres, preserve, project, redis, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Redis = redis("Redis", { region: "ams" });
  Redis.deploy = { startCommand: "/bin/sh -c \"rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH\"" };
  const Postgres = postgres("Postgres", { region: "ams" });
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "ams", sizeMB: 500 });
  const redisVolume = volume("redis-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "ams", sizeMB: 500 });
  const mockPikvm = service("mock-pikvm", {
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "infra/spike/Dockerfile" },
    replicas: { "ams": 1 },
  });
  const cropApi = service("crop-api", {
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "apps/api/Dockerfile" },
    replicas: { "ams": 1 },
    env: { CORS_ORIGIN: preserve(), CREDENTIALS_ENCRYPTION_KEY: preserve(), DATABASE_URL: preserve(), JWT_ACCESS_SECRET: preserve(), JWT_REFRESH_SECRET: preserve(), NODE_ENV: preserve(), REDIS_URL: preserve() },
  });

  return project("crop-demo", {
    resources: [Redis, mockPikvm, Postgres, cropApi, postgresVolume, redisVolume],
  });
});
