import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import * as cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import { assertProductionSafety } from "./security-checks";

async function bootstrap() {
  assertProductionSafety();
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser());
  app.enableCors({
    origin: process.env.FRONTEND_ORIGIN || true,
    credentials: true,
  });
  const port = process.env.PORT || 8080;
  await app.listen(port, "0.0.0.0");
  console.log(`API service listening on port ${port}`);
}
bootstrap();
