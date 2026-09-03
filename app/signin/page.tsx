import type { Metadata } from "next";
import { SignInForm } from "@/app/signin/sign-in-form";

export const metadata: Metadata = {
  title: "Sign in",
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
      error={first(params.error) ?? (signedOut ? "signed_out" : undefined)}
      next={first(params.next)}
    />
  );
}
