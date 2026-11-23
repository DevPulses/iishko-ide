import { useState } from "react";
import { cn } from "~/lib/utils";

export function ChubbyClaudeMascot() {
  const [burping, setBurping] = useState(false);
  const [burpText, setBurpText] = useState("");

  const burpPhrases = [
    "*БЁРП!* <div/>",
    "*РЫГ* 01100101",
    "BURRRRP! return null;",
    "*ИИК* [object Object]",
    "*БЫДЛОКОД ИЗРЫГНУТ*",
  ];

  const handlePoke = () => {
    if (burping) return;
    const phrase = burpPhrases[Math.floor(Math.random() * burpPhrases.length)] ?? "*БЁРП!*";
    setBurpText(phrase);
    setBurping(true);
    setTimeout(() => {
      setBurping(false);
    }, 2200);
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 select-none">
      {burping && (
        <div className="absolute -top-9 right-2 whitespace-nowrap rounded-lg border border-amber-500/30 bg-amber-950/80 px-2 py-0.5 font-mono text-ui-xs font-bold text-amber-200 shadow-lg animate-bounce">
          {burpText}
        </div>
      )}
      <button
        type="button"
        onClick={handlePoke}
        title="Тыкни в жирного Клода, чтоб рыгнул кодом!"
        className={cn(
          "relative flex items-center justify-center p-2 rounded-2xl bg-amber-500/10 border border-amber-500/20 shadow-md backdrop-blur-sm transition-transform hover:scale-110 active:scale-95 cursor-pointer",
          burping && "animate-pulse scale-125",
        )}
      >
        <svg
          width="36"
          height="36"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="text-[#d97757] transition-transform duration-150"
        >
          {/* Fat Claude Mascot (Claw'd) */}
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M21 3V8H24V14H21V21H18V16H16V21H14V16H10V21H8V16H6V21H3V14H0V8H3V3H21ZM16 6V8H18V6H16ZM6 8H8V6H6V8Z"
            fill="currentColor"
          />
          {burping && <circle cx="12" cy="11" r="2.5" fill="#1e1e1e" />}
        </svg>
      </button>
    </div>
  );
}
