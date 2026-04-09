import { FaYoutube, FaInstagram, FaTiktok, FaLinkedinIn, FaFacebookF, FaThreads } from "react-icons/fa6";

const PLATFORM_ICONS: Record<string, { icon: React.ComponentType<{ className?: string }>; color: string }> = {
  youtube: { icon: FaYoutube, color: "text-red-500" },
  instagram: { icon: FaInstagram, color: "text-pink-500" },
  instagram_2nd: { icon: FaInstagram, color: "text-pink-500" },
  tiktok: { icon: FaTiktok, color: "text-[#fafafa]" },
  linkedin: { icon: FaLinkedinIn, color: "text-blue-400" },
  facebook: { icon: FaFacebookF, color: "text-blue-500" },
  threads: { icon: FaThreads, color: "text-[#fafafa]" },
};

export function PlatformIcon({ platform, className }: { platform: string; className?: string }) {
  const entry = PLATFORM_ICONS[platform];
  if (!entry) return null;
  const Icon = entry.icon;
  return <Icon className={`${className ?? "size-4"} ${entry.color}`} />;
}
