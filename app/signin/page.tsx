import type { Metadata } from "next";
import { SignInForm } from "@/app/signin/sign-in-form";
import { sessionOrigin } from "@/lib/auth/session-host";
import { isDemoMode } from "@/lib/config";

export const metadata: Metadata = {
  title: "Connect your store",
};

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const signedOut = first(params.signed_out) === "1";
  return (
    <SignInForm
      appUrl={sessionOrigin()}
      demoMode={isDemoMode()}
      error={first(params.error) ?? (signedOut ? "signed_out" : undefined)}
      shop={first(params.shop)}
    />
  );
}
