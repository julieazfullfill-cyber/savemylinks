import { useI18n } from "./i18n.jsx";

export default function LanguageSwitcher() {
  const { lang, setLang } = useI18n();

  return (
    <div className="lang-switcher">
      <button
        type="button"
        className={lang === "vi" ? "active" : ""}
        onClick={() => setLang("vi")}
      >
        VI
      </button>
      <button
        type="button"
        className={lang === "en" ? "active" : ""}
        onClick={() => setLang("en")}
      >
        EN
      </button>
    </div>
  );
}
