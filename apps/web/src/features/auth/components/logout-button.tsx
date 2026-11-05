"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { callApi } from "@/shared/api/browser-api";
import { Button } from "@/shared/ui/button";

export function LogoutButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await callApi("/auth/logout", { method: "POST" });
          router.push("/");
          router.refresh();
        })
      }
    >
      Log out
    </Button>
  );
}
