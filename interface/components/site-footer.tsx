export function SiteFooter() {
  return (
    <footer className="border-t border-zinc-900">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-xs text-zinc-600">
        <span className="text-base font-semibold text-zinc-400">enwise</span>
        <span>© {new Date().getFullYear()}</span>
      </div>
    </footer>
  );
}
