import { useEffect, useState } from "react";
import { getToken, me, setToken } from "./api.js";
import AuthScreen from "./AuthScreen.jsx";
import UserDashboard from "./UserDashboard.jsx";
import AdminDashboard from "./AdminDashboard.jsx";
import LanguageSwitcher from "./LanguageSwitcher.jsx";
import { useI18n } from "./i18n.jsx";

export default function App() {
  const { t } = useI18n();
  const [user, setUser] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setCheckingSession(false);
      return;
    }
    me()
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setCheckingSession(false));
  }, []);

  const handleLoggedIn = (token) => {
    setToken(token);
    me().then(setUser);
  };

  const handleLogout = () => {
    setToken(null);
    setUser(null);
  };

  if (checkingSession) return null;

  if (!user) {
    return <AuthScreen onLoggedIn={handleLoggedIn} />;
  }

  return (
    <div className="app">
      <header className="top-bar">
        <h1>{t("app.title")}</h1>
        <div className="top-bar-user">
          <LanguageSwitcher />
          <span>
            {user.email} <span className="role-tag">{user.role}</span>
          </span>
          <button className="link-button" onClick={handleLogout}>
            {t("app.logout")}
          </button>
        </div>
      </header>

      {user.role === "admin" ? <AdminDashboard /> : <UserDashboard />}
    </div>
  );
}
