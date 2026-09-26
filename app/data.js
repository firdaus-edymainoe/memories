window.MEMORIES_DATA = {
  user: { name: "Aisha", greeting: "Good afternoon" },
  family: [
    { id: "aisha", name: "Aisha", role: "You" },
    { id: "amir", name: "Amir", role: "Husband" },
    { id: "mom", name: "Mom", role: "Family" },
  ],
  drives: [
    { id: "mac", name: "This Mac", kind: "computer", online: true, used: 182, total: 512, color: "#3B82F6" },
    {
      id: "phone", name: "Aisha’s iPhone", kind: "phone", online: true, used: 64, total: 128, color: "#10B981",
      folders: [
        { id: "dcim", name: "DCIM", parent: null, types: ["photo", "video"], count: "2,254", size: "41 GB" },
        { id: "camera", name: "Camera", parent: "dcim", types: ["photo", "video"], count: "1,842", size: "38 GB" },
        { id: "screenshots", name: "Screenshots", parent: "dcim", types: ["photo"], count: "412", size: "3.1 GB" },
        { id: "whatsapp", name: "WhatsApp Media", parent: null, types: ["photo", "video"], count: "412", size: "3.1 GB" },
        { id: "downloads", name: "Downloads", parent: null, types: ["document"], count: "28", size: "190 MB" },
      ],
    },
    {
      id: "ssd", name: "Summer SSD", kind: "disk", online: false, used: 1400, total: 2000, color: "#F59E0B",
      folders: [
        { id: "ssd-root", name: "Photos", parent: null, types: ["photo", "video"], count: "4,342", size: "296 GB" },
        { id: "ssd-wedding", name: "Wedding", parent: "ssd-root", types: ["photo", "video"], count: "240", size: "86 GB" },
        { id: "ssd-family", name: "Family photos", parent: "ssd-root", types: ["photo"], count: "4,102", size: "210 GB" },
      ],
    },
    {
      id: "usb", name: "Travel USB", kind: "usb", online: false, used: 28, total: 64, color: "#8B5CF6",
      folders: [
        { id: "usb-photos", name: "Photos", types: ["photo"], count: "86", size: "1.2 GB" },
        { id: "usb-clips", name: "Clips", types: ["video"], count: "4", size: "2.6 GB" },
        { id: "usb-docs", name: "Travel docs", types: ["document"], count: "9", size: "24 MB" },
      ],
    },
    { id: "cloud", name: "Memories Cloud", kind: "cloud", online: true, used: 12, total: 100, color: "#3B82F6", sell: true },
  ],
  backups: [
    {
      id: "bk1",
      source: "phone",
      folders: ["camera", "whatsapp"],
      dest: "ssd",
      lastRun: null,
      status: "idle",
    },
  ],
  folders: [],
  albums: [
    { id: "alb-wedding", name: "Your Wedding", count: 4, date: "Aug 2025" },
    { id: "alb-raya", name: "Hari Raya 2026", count: 3, date: "Apr 2026" },
    { id: "alb-renovation", name: "Kitchen renovation", count: 2, date: "Jan 2026" },
  ],
  files: [
    {
      id: "f1", name: "First dance.jpg", type: "photo", mime: "image/jpeg", size: "4.2 MB",
      folder: null, album: "alb-wedding", date: "2025-08-12", place: "Kuala Lumpur", device: "phone",
      inbox: false,
      src: "https://images.unsplash.com/photo-1519741497674-611481863552?w=1200&q=80",
      locations: [
        { drive: "phone", status: "ready" },
        { drive: "ssd", status: "ready" },
        { drive: "cloud", status: "copying", progress: 62 },
      ],
    },
    {
      id: "f2", name: "Garden vows.jpg", type: "photo", mime: "image/jpeg", size: "3.8 MB",
      folder: null, album: "alb-wedding", date: "2025-08-12", place: "Kuala Lumpur", device: "phone",
      inbox: false,
      src: "https://images.unsplash.com/photo-1511285560929-80b456fea0bc?w=1200&q=80",
      locations: [
        { drive: "phone", status: "ready" },
        { drive: "usb", status: "ready" },
      ],
    },
    {
      id: "f3", name: "Family portrait.jpg", type: "photo", mime: "image/jpeg", size: "5.1 MB",
      folder: null, album: "alb-wedding", date: "2025-08-12", place: "Kuala Lumpur", device: "phone",
      inbox: false,
      src: "https://images.unsplash.com/photo-1511895426328-dc8714191300?w=1200&q=80",
      locations: [{ drive: "ssd", status: "ready" }],
    },
    {
      id: "f4", name: "Reception.mov", type: "video", mime: "video/mp4", size: "1.9 GB",
      folder: null, album: "alb-wedding", date: "2025-08-12", place: "Kuala Lumpur", device: "phone",
      inbox: false,
      src: "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?w=1200&q=80",
      locations: [
        { drive: "phone", status: "ready" },
        { drive: "ssd", status: "ready" },
      ],
    },
    {
      id: "f5", name: "Amir birthday.jpg", type: "photo", mime: "image/jpeg", size: "2.4 MB",
      folder: null, album: null, date: "2026-03-18", place: "Home", device: "phone",
      inbox: false,
      src: "https://images.unsplash.com/photo-1464349095431-e9a21285b5f3?w=1200&q=80",
      locations: [{ drive: "phone", status: "ready" }],
    },
    {
      id: "f6", name: "Park afternoon.jpg", type: "photo", mime: "image/jpeg", size: "3.1 MB",
      folder: null, album: null, date: "2026-03-24", place: "Taman Tasik", device: "phone",
      inbox: true,
      src: "https://images.unsplash.com/photo-1502082553048-f009c37129b9?w=1200&q=80",
      locations: [{ drive: "phone", status: "ready" }],
    },
    {
      id: "f7", name: "Hari Raya table.jpg", type: "photo", mime: "image/jpeg", size: "2.9 MB",
      folder: null, album: "alb-raya", date: "2026-04-02", place: "Home", device: "mac",
      inbox: false,
      src: "https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=1200&q=80",
      locations: [
        { drive: "mac", status: "ready" },
        { drive: "cloud", status: "ready" },
      ],
    },
    {
      id: "f8", name: "Ketupat.mov", type: "video", mime: "video/mp4", size: "420 MB",
      folder: null, album: "alb-raya", date: "2026-04-02", place: "Home", device: "phone",
      inbox: false,
      src: "https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=1200&q=80",
      locations: [
        { drive: "phone", status: "ready" },
        { drive: "ssd", status: "copying", progress: 28 },
      ],
    },
    {
      id: "f9", name: "Passport scan.pdf", type: "document", mime: "application/pdf", size: "1.1 MB",
      folder: null, album: null, date: "2026-01-09", device: "mac",
      inbox: false, src: null,
      locations: [
        { drive: "mac", status: "ready" },
        { drive: "cloud", status: "ready" },
      ],
    },
    {
      id: "f10", name: "Kitchen quote.pdf", type: "document", mime: "application/pdf", size: "840 KB",
      folder: null, album: "alb-renovation", date: "2026-01-14", device: "mac",
      inbox: true, src: null,
      locations: [{ drive: "mac", status: "ready" }],
    },
    {
      id: "f11", name: "Cabinets.jpg", type: "photo", mime: "image/jpeg", size: "3.4 MB",
      folder: null, album: "alb-renovation", date: "2026-01-20", place: "Home", device: "phone",
      inbox: false,
      src: "https://images.unsplash.com/photo-1556912173-46c336c7fd55?w=1200&q=80",
      locations: [
        { drive: "phone", status: "ready" },
        { drive: "mac", status: "ready" },
      ],
    },
    {
      id: "f12", name: "Langkawi sunset.jpg", type: "photo", mime: "image/jpeg", size: "4.8 MB",
      folder: null, album: null, date: "2025-12-20", place: "Langkawi", device: "phone",
      inbox: false,
      src: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1200&q=80",
      locations: [
        { drive: "phone", status: "ready" },
        { drive: "ssd", status: "ready" },
        { drive: "cloud", status: "ready" },
      ],
    },
    {
      id: "f13", name: "Train ride.mov", type: "video", mime: "video/mp4", size: "780 MB",
      folder: null, album: null, date: "2026-02-11", place: "On the train", device: "phone",
      inbox: false,
      src: "https://images.unsplash.com/photo-1544620341-11cb2cd7c67d?w=1200&q=80",
      locations: [{ drive: "usb", status: "ready" }],
    },
    {
      id: "f14", name: "Insurance.pdf", type: "document", mime: "application/pdf", size: "620 KB",
      folder: null, album: null, date: "2026-05-03", device: "mac",
      inbox: true, src: null,
      locations: [{ drive: "mac", status: "ready" }],
    },
    {
      id: "f15", name: "This week last year.jpg", type: "photo", mime: "image/jpeg", size: "2.7 MB",
      folder: null, album: null, date: "2025-09-12", place: "Home", device: "phone",
      inbox: false,
      src: "https://images.unsplash.com/photo-1609220136736-443140cff224?w=1200&q=80",
      locations: [
        { drive: "phone", status: "ready" },
        { drive: "ssd", status: "ready" },
      ],
    },
  ],
  activity: [
    { id: "a1", text: "Mom viewed Wedding", time: "2h ago" },
    { id: "a2", text: "Amir plugged in Travel USB", time: "Yesterday" },
    { id: "a3", text: "12 photos copied to Summer SSD", time: "Tue" },
  ],
  versions: {
    f9: [
      { n: 3, current: true, date: "12 Sep 2026", by: "Aisha", note: "Renewal page added" },
      { n: 2, current: false, date: "3 Mar 2026", by: "Aisha", note: "Address change" },
      { n: 1, current: false, date: "9 Jan 2026", by: "Aisha", note: "Original scan" },
    ],
  },
};
