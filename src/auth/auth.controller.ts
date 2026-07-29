import { Body, Controller, Post, Res, HttpCode } from "@nestjs/common";
import type { Response } from "express";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("login")
  @HttpCode(200)
  async login(
    @Body() body: { email: string; password: string },
    @Res({ passthrough: true }) res: Response
  ) {
    const result = await this.authService.login(body?.email ?? "", body?.password ?? "");

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    res.cookie("uvc_session", result.token, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: 15 * 60 * 1000,
    });

    // Also returned in the body: the frontend runs on a different domain
    // than this API, so it can't read this cookie directly — it uses this
    // token to set its own same-domain session cookie instead.
    return { ok: true, token: result.token };
  }
}
