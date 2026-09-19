/**
 * Static inspiration catalog — real Pinterest pins (manual scrape) as the
 * pre-AI stand-in. Each entry carries the tags the future vision pass should
 * emit — when the AI intake ships, keep the tag contract and swap `uri` for
 * user art or AI generations.
 *
 * Source: pinimg CDN URLs scraped from Pinterest search (Sep 2026, all HTTP
 * 200 re-validated at swap time). Hotlink-friendly for dev/QA. Before
 * production, self-host under assets/ or swap to the user's own scrapes —
 * never ship someone else's CDN as the product's permanent art, and confirm
 * licensing for any pin reused beyond internal QA.
 */

export interface InspirationItem {
  /** Stable id — future AI intake keys tags/votes off this. */
  id: string;
  /** Photo URL (swap point for user scrapes / AI art). */
  uri: string;
  /** Short vibe label shown on the card. */
  label: string;
  /** Tags the future vision pass should emit for this image. */
  tags: string[];
  /** Pinterest search query this pin was scraped from (provenance). */
  source: string;
}

/**
 * 10-look rack: mens street / old money / minimal, womens street / minimal /
 * old money, plus summer casual — so both quiz sides see familiar vibes.
 * Portrait 474x crops fit the 3:4 card geometry.
 */
export const INSPIRATION_RACK: readonly InspirationItem[] = [
  {
    id: 'pin-street-1',
    uri: 'https://i.pinimg.com/474x/5f/fb/17/5ffb17342fee47bafdd8d7b9978e9d5d.jpg',
    label: 'Street ease',
    tags: ['streetwear', 'oversized', 'casual'],
    source: 'mens streetwear outfit',
  },
  {
    id: 'pin-street-2',
    uri: 'https://i.pinimg.com/474x/6c/52/fe/6c52fe31896392e763a72a08f32851a8.jpg',
    label: 'Off-duty street',
    tags: ['streetwear', 'denim', 'casual'],
    source: 'mens streetwear outfit',
  },
  {
    id: 'pin-oldmoney-1',
    uri: 'https://i.pinimg.com/474x/52/1c/e9/521ce9f4074a6cafda0a608bcf129df6.jpg',
    label: 'Sharp tailoring',
    tags: ['tailored', 'classic', 'office'],
    source: 'old money men outfit style',
  },
  {
    id: 'pin-oldmoney-2',
    uri: 'https://i.pinimg.com/474x/57/79/b5/5779b5292ad00222a124203e54824199.jpg',
    label: 'Quiet luxury',
    tags: ['old money', 'tailored', 'classic'],
    source: 'old money men outfit style',
  },
  {
    id: 'pin-minimal-1',
    uri: 'https://i.pinimg.com/474x/45/13/d8/4513d8c18ffb521e0a61485b845d74e5.jpg',
    label: 'Clean minimal',
    tags: ['minimal', 'monochrome', 'tailored'],
    source: 'minimal menswear outfit',
  },
  {
    id: 'pin-minimal-2',
    uri: 'https://i.pinimg.com/474x/76/1b/2d/761b2daf9099bed5d8bb69363711e5f0.jpg',
    label: 'Soft neutrals',
    tags: ['neutral', 'minimal', 'cozy'],
    source: 'minimal menswear outfit',
  },
  {
    id: 'pin-wstreet-1',
    uri: 'https://i.pinimg.com/474x/11/29/c7/1129c75b178b6d998e97c325770d463d.jpg',
    label: 'Her street',
    tags: ['streetwear', 'oversized', 'casual'],
    source: 'womens streetwear outfit',
  },
  {
    id: 'pin-wmin-1',
    uri: 'https://i.pinimg.com/474x/17/eb/2c/17eb2c336b6cb52adb4ac3abeee7eeda.jpg',
    label: 'Her minimal',
    tags: ['minimal', 'chic', 'neutral'],
    source: 'womens minimal outfit aesthetic',
  },
  {
    id: 'pin-wold-1',
    uri: 'https://i.pinimg.com/474x/05/95/76/05957661157398284a5f625d11f21b31.jpg',
    label: 'Her polish',
    tags: ['elegant', 'classic', 'office'],
    source: 'old money women outfit',
  },
  {
    id: 'pin-summer-1',
    uri: 'https://i.pinimg.com/474x/07/14/de/0714de04dfc1de87394595ba0fe93be4.jpg',
    label: 'Summer casual',
    tags: ['casual', 'linen', 'relaxed'],
    source: 'mens summer casual outfit',
  },
];
