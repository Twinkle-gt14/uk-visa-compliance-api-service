import { Body, Controller, Post, Req, Res, HttpCode, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { AuthGuard, extractSessionToken } from "./auth.guard";

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
    // token to set its own same-domain session cookie instead. role/
    // employeeId are duplicated here (they're already inside the JWT)
    // purely so the frontend can render role-appropriate UI without
    // decoding a token it doesn't have the secret for - the JWT itself
    // remains the only thing any endpoint actually trusts.
    return {
      ok: true,
      token: result.token,
      mustChangePassword: result.mustChangePassword,
      role: result.role,
      employeeId: result.employeeId,
    };
  }

  /** Silent renewal, polled by the frontend a couple of minutes before
   * the access token expires (see uk-visa-shell/lib/auth.tsx). Not
   * behind @UseGuards(AuthGuard) on purpose - a token that's already a
   * few seconds past its 15-minute expiry is exactly the case this
   * endpoint exists to handle, and AuthGuard would reject it outright.
   * AuthService.refresh() does its own signature verification and
   * absolute-session-age check instead. */
  @Post("refresh")
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = extractSessionToken(req);
    if (!token) {
      return { ok: false, error: "No session." };
    }

    const result = await this.authService.refresh(token);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    res.cookie("uvc_session", result.token, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: 15 * 60 * 1000,
    });

    return { ok: true, token: result.token, role: result.role, employeeId: result.employeeId };
  }

  /** The logged-in user changing their own password - also how the
   * forced first-login change (default password = employee id label)
   * gets completed, since must_change_password only clears here. */
  @Post("change-password")
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async changePassword(@Req() req: Request, @Body() body: { oldPassword: string; newPassword: string }) {
    if (!body?.oldPassword || !body?.newPassword) {
      return { ok: false, error: "Both current and new password are required." };
    }
    if (body.newPassword.length < 8) {
      return { ok: false, error: "New password must be at least 8 characters." };
    }
    return this.authService.changeOwnPassword(req.user!.userId, body.oldPassword, body.newPassword);
  }
}
