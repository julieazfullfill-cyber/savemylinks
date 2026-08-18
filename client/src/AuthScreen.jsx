import { useState } from "react";
import { login, register } from "./api.js";
import LanguageSwitcher from "./LanguageSwitcher.jsx";
import { useI18n } from "./i18n.jsx";

export default function AuthScreen({ onLoggedIn }) {
  const { t } = useI18n();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (mode === "register") {
        await register(email, password);
      }
      const result = await login(email, password);
      onLoggedIn(result.access_token);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-lang-switcher">
          <LanguageSwitcher />
        </div>
        <h1>{t("auth.title")}</h1>
        <div className="mode-toggle">
          <button
            type="button"
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
          >
            {t("auth.login")}
          </button>
          <button
            type="button"
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
          >
            {t("auth.register")}
          </button>
        </div>
        <form onSubmit={handleSubmit} className="auth-form">
          <input
            type="email"
            placeholder={t("auth.email")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder={t("auth.password")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={6}
            required
          />
          <button type="submit" disabled={loading}>
            {loading ? t("auth.submitting") : mode === "login" ? t("auth.login") : t("auth.createAccount")}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
