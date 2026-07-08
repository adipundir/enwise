// Brand marks for the EVM chains we accept stablecoins on (USDC on Base /
// Arbitrum, USDT on Ethereum). Inlined (not <img>) so they scale crisply,
// inherit sizing via className, and add no extra request. Base: canonical
// circle-with-slot symbol (#0052FF). Arbitrum One: faceted "A" mark.
// Ethereum: official faceted diamond (#627EEA). Source: official brand kits.

export function BaseLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 111 111"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        fill="#0052FF"
        d="M54.921 110.034C85.359 110.034 110.034 85.402 110.034 55.017 110.034 24.632 85.359 0 54.921 0 26.043 0 2.353 22.171 0 50.392h72.847v9.25H0c2.353 28.27 26.043 50.392 54.921 50.392"
      />
    </svg>
  );
}

export function ArbitrumLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        fill="#213147"
        d="M4.515 8.471v7.056c0 .45.245.867.64 1.092l6.205 3.529a1.3 1.3 0 0 0 1.28 0l6.203-3.53c.396-.224.64-.64.64-1.09V8.47c0-.45-.244-.867-.64-1.091L12.64 3.85a1.3 1.3 0 0 0-1.28 0L5.155 7.38a1.25 1.25 0 0 0-.639 1.091"
      />
      <path
        fill="#12AAFF"
        d="m13.353 13.368-.885 2.39a.3.3 0 0 0 0 .205l1.523 4.112 1.76-1.001-2.113-5.706a.152.152 0 0 0-.285 0m1.774-4.019a.152.152 0 0 0-.285 0l-.885 2.39a.3.3 0 0 0 0 .205l2.494 6.732 1.761-1.001z"
      />
      <path
        fill="#9DCCED"
        d="M11.998 4.115a.3.3 0 0 1 .126.033l6.715 3.818a.25.25 0 0 1 .126.214v7.635c0 .089-.048.17-.126.214l-6.715 3.819a.25.25 0 0 1-.126.032.3.3 0 0 1-.125-.032l-6.715-3.815a.25.25 0 0 1-.126-.215V8.182c0-.089.048-.17.126-.215l6.715-3.818a.26.26 0 0 1 .125-.034m0-1.115c-.238 0-.478.06-.692.183L4.593 7A1.36 1.36 0 0 0 3.9 8.182v7.635c0 .487.264.938.693 1.181l6.714 3.819a1.41 1.41 0 0 0 1.386 0l6.714-3.818a1.36 1.36 0 0 0 .693-1.182V8.182A1.36 1.36 0 0 0 19.407 7l-6.716-3.817A1.4 1.4 0 0 0 11.998 3"
      />
      <path fill="#213147" d="m7.559 18.685.617-1.666 1.244 1.018-1.163 1.046z" />
      <path
        fill="#fff"
        d="M11.433 7.635H9.731a.3.3 0 0 0-.285.197l-3.649 9.852 1.761 1.001 4.018-10.849a.15.15 0 0 0-.143-.2m2.979-.001h-1.703a.3.3 0 0 0-.284.197l-4.167 11.25 1.761 1 4.535-12.246a.15.15 0 0 0-.142-.2"
      />
    </svg>
  );
}

export function EthereumLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 256 417"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path fill="#627EEA" fillOpacity=".6" d="m127.96 0-2.8 9.5v275.668l2.8 2.79 127.96-75.638z" />
      <path fill="#627EEA" d="M127.96 0 0 212.32l127.96 75.639V154.158z" />
      <path fill="#627EEA" fillOpacity=".6" d="m127.96 312.187-1.575 1.92v98.199l1.575 4.6L256 236.587z" />
      <path fill="#627EEA" d="M127.96 416.905v-104.72L0 236.585z" />
      <path fill="#627EEA" fillOpacity=".2" d="m127.96 287.958 127.96-75.637-127.96-58.162z" />
      <path fill="#627EEA" fillOpacity=".6" d="M0 212.32l127.96 75.638v-133.8z" />
    </svg>
  );
}

