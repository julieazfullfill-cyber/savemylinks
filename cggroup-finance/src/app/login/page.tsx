import { login } from "./actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form action={login} className="card w-full max-w-sm space-y-4 p-6">
        <div>
          <div className="text-xs font-semibold uppercase tracking-widest text-accent">CGGroup</div>
          <h1 className="mt-1 text-xl font-bold">Đăng nhập hệ thống tài chính</h1>
        </div>
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-crit">{error}</p>}
        <input type="hidden" name="next" value={next ?? ""} />
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input className="input" id="email" name="email" type="email" required autoFocus autoComplete="username" />
        </div>
        <div>
          <label className="label" htmlFor="password">Mật khẩu</label>
          <input className="input" id="password" name="password" type="password" required autoComplete="current-password" />
        </div>
        <button className="btn-primary w-full justify-center py-2" type="submit">Đăng nhập</button>
      </form>
    </main>
  );
}
