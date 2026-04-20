import { FaYoutube, FaInstagram, FaTiktok, FaLinkedinIn, FaFacebookF, FaThreads } from "react-icons/fa6";

/* Single-accent rule: every platform icon renders in terracotta so the
   dashboard reads as one coherent surface instead of a rainbow of brand
   hexes. Platform identity is carried by the logo shape, not its color. */
const ACCENT = "text-[#ae5630]";

const PLATFORM_ICONS: Record<string, { icon: React.ComponentType<{ className?: string }>; color: string }> = {
  youtube: { icon: FaYoutube, color: ACCENT },
  instagram: { icon: FaInstagram, color: ACCENT },
  instagram_2nd: { icon: FaInstagram, color: ACCENT },
  tiktok: { icon: FaTiktok, color: ACCENT },
  linkedin: { icon: FaLinkedinIn, color: ACCENT },
  facebook: { icon: FaFacebookF, color: ACCENT },
  threads: { icon: FaThreads, color: ACCENT },
};

export function PlatformIcon({ platform, className }: { platform: string; className?: string }) {
  const entry = PLATFORM_ICONS[platform];
  if (!entry) return null;
  const Icon = entry.icon;
  return <Icon className={`${className ?? "size-4"} ${entry.color}`} />;
}
