"use client";

import { useState } from "react";
import { Button } from "@repo/ui/button";

type CliAuthRedirectProps = {
  port: string;
  state: string;
  token: string;
  userName: string;
};

export const CliAuthRedirect = ({ port, state, token, userName }: CliAuthRedirectProps) => {
  const [authorized, setAuthorized] = useState(false);

  const handleAuthorize = () => {
    setAuthorized(true);
    window.location.href = `http://localhost:${port}/callback?token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`;
  };

  if (authorized) {
    return (
      <div className="text-center">
        <h1 className="text-lg font-light">CLI Authorized</h1>
        <p className="text-muted-foreground text-sm">You can close this window.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 text-center">
      <h1 className="text-lg font-light">Authorize VG CLI</h1>
      <p className="text-muted-foreground text-sm">
        The VG CLI is requesting access as <strong>{userName}</strong>.
      </p>
      <Button onClick={handleAuthorize}>Authorize</Button>
    </div>
  );
};
