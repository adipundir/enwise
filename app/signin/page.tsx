import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { SiteHeader } from "@/components/site-header";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const session = await auth();
  const { callbackUrl } = await searchParams;

  if (session) {
    redirect(callbackUrl ?? "/dashboard");
  }

  const redirectTo = callbackUrl ?? "/dashboard";

  return (
    <div className="flex flex-1 flex-col">
      <SiteHeader ctaHref="/signin" />
      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-md space-y-8 rounded-2xl border border-zinc-900 bg-[#0d0d0d] p-10 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset]">
          <div className="space-y-3">
            <h1 className="font-serif text-3xl leading-tight">
              Sign in to envoice.
            </h1>
            <p className="text-sm text-zinc-500">
              One account. One API key. Then you live in Claude.
            </p>
          </div>
          <div className="space-y-3">
            <form
              action={async () => {
                "use server";
                await signIn("github", { redirectTo });
              }}
            >
              <button
                type="submit"
                className="flex w-full items-center justify-center gap-3 rounded-lg bg-zinc-100 px-4 py-3 text-sm font-medium text-zinc-950 hover:bg-white"
              >
                <GitHubIcon />
                Continue with GitHub
              </button>
            </form>
            <form
              action={async () => {
                "use server";
                await signIn("google", { redirectTo });
              }}
            >
              <button
                type="submit"
                className="flex w-full items-center justify-center gap-3 rounded-lg border border-zinc-800 bg-[#0a0a0a] px-4 py-3 text-sm font-medium text-zinc-100 hover:border-zinc-700 hover:bg-zinc-900"
              >
                <GoogleIcon />
                Continue with Google
              </button>
            </form>
          </div>
          <p className="text-xs text-zinc-600">
            By continuing you agree to reasonable, not-yet-written terms.
            We'll do our best.
          </p>
        </div>
      </main>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.07 5.07 0 0 1-2.2 3.33v2.77h3.56c2.08-1.92 3.28-4.74 3.28-8.11z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.77c-.99.66-2.25 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A10.99 10.99 0 0 0 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.1c-.22-.66-.35-1.37-.35-2.1s.13-1.44.35-2.1V7.06H2.18a10.99 10.99 0 0 0 0 9.88l3.66-2.84z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.07.56 4.21 1.64l3.15-3.15C17.46 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38z"
        fill="#EA4335"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="currentColor">
      <path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.8 10.9.6.1.8-.2.8-.5v-2c-3.2.7-3.8-1.4-3.8-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.3 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.3 11.3 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.5 4.5-1.5 7.8-5.8 7.8-10.9C23.5 5.7 18.3.5 12 .5z" />
    </svg>
  );
}
