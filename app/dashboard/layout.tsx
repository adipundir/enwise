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
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6 sm:py-5">
          <Link
            href="/dashboard"
            className="text-base font-semibold tracking-tight text-zinc-100"
          >
            enwise
          </Link>
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-zinc-400">
            <Link href="/dashboard" className="hover:text-zinc-100">
              Dashboard
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
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">{children}</div>
      </main>
    </div>
  );
}
