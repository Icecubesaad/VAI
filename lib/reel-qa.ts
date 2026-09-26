/**
 * QA-ONLY reel seed (founder-approved interim): AI-generated editorial images
 * (magazine cover + destination poses) produced with scripts/qwen_modal.py
 * `reel` for the QA account, hosted in this project's public `garments`
 * bucket. Replace with the server-side reel pipeline before production —
 * never ship celebrity-likeness imagery; production reels use the user's own
 * photo via the Gemini provider chain.
 */
export interface ReelQaItem {
  id: string;
  uri: string;
  label: string;
}

export const REEL_QA_ITEMS: readonly ReelQaItem[] = [
  { id: 'reel-0', uri: 'https://dhhrtyjwcvfvgzowsrbg.supabase.co/storage/v1/object/public/garments/a5cf202d-25a6-4c31-8d89-80cee6a48471/reel/reel_cover_garment1.jpg', label: 'September cover' },
  { id: 'reel-1', uri: 'https://dhhrtyjwcvfvgzowsrbg.supabase.co/storage/v1/object/public/garments/a5cf202d-25a6-4c31-8d89-80cee6a48471/reel/reel_santorini_garment2.jpg', label: 'Santorini' },
  { id: 'reel-2', uri: 'https://dhhrtyjwcvfvgzowsrbg.supabase.co/storage/v1/object/public/garments/a5cf202d-25a6-4c31-8d89-80cee6a48471/reel/reel_maldives_garment3.jpg', label: 'Maldives' },
  { id: 'reel-3', uri: 'https://dhhrtyjwcvfvgzowsrbg.supabase.co/storage/v1/object/public/garments/a5cf202d-25a6-4c31-8d89-80cee6a48471/reel/reel_paris_person.jpg', label: 'Paris' },
  { id: 'reel-4', uri: 'https://dhhrtyjwcvfvgzowsrbg.supabase.co/storage/v1/object/public/garments/a5cf202d-25a6-4c31-8d89-80cee6a48471/reel/reel_kyoto_garment1.jpg', label: 'Kyoto' },
  { id: 'reel-5', uri: 'https://dhhrtyjwcvfvgzowsrbg.supabase.co/storage/v1/object/public/garments/a5cf202d-25a6-4c31-8d89-80cee6a48471/reel/reel_amalfi_garment2.jpg', label: 'Amalfi' },
  { id: 'reel-6', uri: 'https://dhhrtyjwcvfvgzowsrbg.supabase.co/storage/v1/object/public/garments/a5cf202d-25a6-4c31-8d89-80cee6a48471/reel/reel_alps_garment3.jpg', label: 'Swiss Alps' },
  { id: 'reel-7', uri: 'https://dhhrtyjwcvfvgzowsrbg.supabase.co/storage/v1/object/public/garments/a5cf202d-25a6-4c31-8d89-80cee6a48471/reel/reel_dubai_person.jpg', label: 'Dubai' },
];
