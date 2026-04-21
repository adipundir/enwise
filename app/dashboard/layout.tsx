import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/signin?callbackUrl=/dashboard");
  }

  return (
    <div className="flex flex-col flex-1">
      <header className="border-b border-zinc-900">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Link
            href="/dashboard"
            className="text-base font-semibold tracking-tight text-zinc-100"
          >
            envoice
          </Link>
          <nav className="flex items-center gap-6 text-sm text-zinc-400">
            <Link href="/dashboard" className="hover:text-zinc-100">
              Overview
            </Link>
            <Link href="/dashboard/api-tokens" className="hover:text-zinc-100">
              API tokens
            </Link>
            <Link href="/dashboard/connect" className="hover:text-zinc-100">
              Connect Claude
            </Link>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <button
                type="submit"
                className="text-zinc-500 hover:text-zinc-100"
              >
                Sign out
              </button>
            </form>
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <div className="mx-auto max-w-6xl px-6 py-14">{children}</div>
      </main>
    </div>
  );
}
