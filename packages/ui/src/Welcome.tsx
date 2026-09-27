import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "./icons.js";
import { FileObject } from "./Tile.js";

const PHOTOS = [
  "https://images.unsplash.com/photo-1519741497674-611481863552?w=320&q=70",
  "https://images.unsplash.com/photo-1502082553048-f009c37129b9?w=320&q=70",
  "https://images.unsplash.com/photo-1464349095431-e9a21285b5f3?w=320&q=70",
  "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=320&q=70",
];

const STEPS = [
  {
    title: "Welcome to Memories",
    body: "One calm home for all your family’s files. Photos, videos, school letters, receipts, even app installers. From this computer, your phone and the drives in the drawer.",
  },
  {
    title: "Add the places you keep things",
    body: "Pick a folder on your computer, your phone or a drive. Nothing gets moved or uploaded. Your files stay exactly where they are.",
  },
  {
    title: "You don’t have to organize",
    body: "On a computer you make folders, then rarely keep them tidy. Memories sorts for you instead. Looking for a photo or a receipt? Stay on Type. Looking for that weekend? Switch to Date. Same files, two ways home — no filing required.",
  },
  {
    title: "Unplugged? Still in the list",
    body: "Memories remembers what’s on each drive, so you can find things even when the drive is in a drawer. Plug it in to open them.",
  },
  {
    title: "Keep a spare with Backup",
    body: "Choose a few folders and a drive to copy them to, then press Back up now. Your originals never move.",
  },
];

const spring = { type: "spring", duration: 0.6, bounce: 0.2 } as const;

function SceneWelcome() {
  const items = [
    { name: "Beach day.jpg", kind: "photo" as const, src: PHOTOS[3], x: -150, y: 18, r: -9 },
    { name: "School letter.pdf", kind: "document" as const, x: -58, y: -34, r: -4 },
    { name: "Wedding.jpg", kind: "photo" as const, src: PHOTOS[0], x: 40, y: -6, r: 5 },
    { name: "Printer setup.dmg", kind: "document" as const, x: 138, y: 36, r: 7 },
    { name: "Budget.xlsx", kind: "document" as const, x: -8, y: 62, r: -2 },
    { name: "Birthday.mp4", kind: "video" as const, x: 112, y: -56, r: -6 },
  ];
  return (
    <div className="scene scene-table">
      {items.map((item, i) => (
        <motion.div
          key={item.name}
          className="scene-obj"
          initial={{ opacity: 0, x: item.x * 0.4, y: -160, rotate: item.r * 3 }}
          animate={{ opacity: 1, x: item.x, y: item.y, rotate: item.r }}
          transition={{ ...spring, delay: 0.1 + i * 0.09 }}
          style={{ zIndex: i === 2 ? 5 : i }}
        >
          <FileObject name={item.name} kind={item.kind} src={item.src} />
        </motion.div>
      ))}
    </div>
  );
}

function ScenePlaces() {
  const places: { name: string; icon: IconName; plugAt: number | null }[] = [
    { name: "This Mac · Pictures", icon: "computer", plugAt: null },
    { name: "Aisha’s phone", icon: "phone", plugAt: 0.9 },
    { name: "Summer SSD", icon: "disk", plugAt: 1.5 },
    { name: "Travel USB", icon: "usb", plugAt: 2.1 },
  ];
  return (
    <div className="scene scene-places">
      {places.map((place, i) => (
        <motion.div
          key={place.name}
          className="scene-place"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...spring, delay: i * 0.1 }}
        >
          <span className="scene-place-icon">
            <Icon name={place.icon} size={20} />
          </span>
          <strong>{place.name}</strong>
          <PlugStatus at={place.plugAt} computer={place.plugAt === null} />
        </motion.div>
      ))}
    </div>
  );
}

function PlugStatus({ at, computer }: { at: number | null; computer?: boolean }) {
  const [on, setOn] = useState(at === null);
  useEffect(() => {
    if (at === null) return;
    const id = window.setTimeout(() => setOn(true), at * 1000);
    return () => window.clearTimeout(id);
  }, [at]);
  return (
    <span className={`scene-status${on ? " on" : ""}`}>
      <motion.i animate={on ? { scale: [1, 1.6, 1] } : { scale: 1 }} transition={{ duration: 0.5 }} />
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={on ? "on" : "off"}
          initial={{ opacity: 0, y: 6, filter: "blur(2px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -6, filter: "blur(2px)" }}
          transition={{ duration: 0.25 }}
        >
          {on ? (computer ? "Ready" : "Plugged in") : "Unplugged"}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

const LENS_ITEMS = [
  { id: "a", name: "Wedding.jpg", kind: "photo" as const, src: PHOTOS[0], type: 0, date: 0 },
  { id: "b", name: "Invitation.pdf", kind: "document" as const, type: 1, date: 0 },
  { id: "c", name: "Garden.jpg", kind: "photo" as const, src: PHOTOS[1], type: 0, date: 1 },
  { id: "d", name: "Receipt.pdf", kind: "document" as const, type: 1, date: 1 },
  { id: "e", name: "Cake.jpg", kind: "photo" as const, src: PHOTOS[2], type: 0, date: 0 },
  { id: "f", name: "Setup.exe", kind: "document" as const, type: 2, date: 1 },
];

function SceneLens() {
  const reduce = useReducedMotion();
  const [lens, setLens] = useState<"type" | "date">("type");
  useEffect(() => {
    if (reduce) return;
    const id = window.setInterval(() => setLens((current) => (current === "type" ? "date" : "type")), 2400);
    return () => window.clearInterval(id);
  }, [reduce]);
  const groups =
    lens === "type"
      ? ["Photos", "Documents", "Installers"].map((label, i) => ({ label, items: LENS_ITEMS.filter((x) => x.type === i) }))
      : ["August 2025", "July 2025"].map((label, i) => ({ label, items: LENS_ITEMS.filter((x) => x.date === i) }));
  const question = lens === "type" ? "“I’m looking for a photo…”" : "“I’m looking for that day…”";
  return (
    <div className="scene scene-lens">
      <AnimatePresence mode="wait" initial={false}>
        <motion.p
          key={lens}
          className="scene-lens-q"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.22 }}
        >
          {question}
        </motion.p>
      </AnimatePresence>
      <div className="seg mini" role="presentation">
        {(["type", "date"] as const).map((value) => (
          <button key={value} type="button" tabIndex={-1} className={lens === value ? "on" : ""} onClick={() => setLens(value)}>
            {lens === value ? <motion.i layoutId="scene-seg" className="seg-pill" transition={spring} /> : null}
            <span>{value === "type" ? "Type" : "Date"}</span>
          </button>
        ))}
      </div>
      <LayoutGroup>
        <div className="scene-trays">
          {groups.map((group) => (
            <motion.div layout key={`${lens}-${group.label}`} className="scene-tray" transition={spring}>
              <motion.strong layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                {group.label}
              </motion.strong>
              <div className="scene-tray-row">
                {group.items.map((item) => (
                  <motion.div key={item.id} layoutId={`lens-${item.id}`} className="scene-mini" transition={spring}>
                    <FileObject name={item.name} kind={item.kind} src={item.src} />
                  </motion.div>
                ))}
              </div>
            </motion.div>
          ))}
        </div>
      </LayoutGroup>
    </div>
  );
}

function SceneUnplugged() {
  const reduce = useReducedMotion();
  const [plugged, setPlugged] = useState(false);
  useEffect(() => {
    if (reduce) return;
    const id = window.setInterval(() => setPlugged((current) => !current), 2200);
    return () => window.clearInterval(id);
  }, [reduce]);
  return (
    <div className="scene scene-unplug">
      <motion.div className="scene-card" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
        <div className="scene-card-img">
          <img src={PHOTOS[0]} alt="" onError={(event) => (event.currentTarget.style.visibility = "hidden")} />
          <motion.div className="scene-card-veil" animate={{ opacity: plugged ? 0 : 1 }} transition={{ duration: 0.35 }}>
            <Icon name="usb" size={22} />
            <span>Plug in Summer SSD to open</span>
          </motion.div>
        </div>
        <div className="scene-card-meta">
          <b>First dance.jpg</b>
          <span>Kept on</span>
          <div className="scene-chips">
            <span className="chip ok">This Mac</span>
            <motion.span className={`chip ${plugged ? "ok" : "off"}`} layout transition={spring}>
              Summer SSD · {plugged ? "plugged in" : "unplugged"}
            </motion.span>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function SceneBackup() {
  return (
    <div className="scene scene-backup">
      <motion.div className="scene-dev" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={spring}>
        <Icon name="phone" size={30} />
        <span>Aisha’s phone</span>
      </motion.div>
      <div className="scene-flight" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <motion.div
            key={i}
            className="scene-fly"
            initial={{ offsetDistance: "0%", opacity: 0, scale: 0.7 }}
            animate={{ offsetDistance: ["0%", "100%"], opacity: [0, 1, 1, 0], scale: [0.7, 1, 1, 0.7] }}
            transition={{ duration: 1.8, delay: 0.4 + i * 0.45, repeat: Infinity, repeatDelay: 0.9, ease: [0.45, 0, 0.2, 1] }}
          >
            <FileObject name={i % 2 ? "Note.pdf" : "Photo.jpg"} kind={i % 2 ? "document" : "photo"} src={PHOTOS[i]} />
          </motion.div>
        ))}
      </div>
      <motion.div className="scene-dev" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={spring}>
        <Icon name="disk" size={30} />
        <span>Summer SSD</span>
      </motion.div>
      <div className="scene-progress">
        <motion.i initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 4.2, ease: "linear", delay: 0.4 }} />
      </div>
    </div>
  );
}

const SCENES = [SceneWelcome, ScenePlaces, SceneLens, SceneUnplugged, SceneBackup];

export function Welcome({ onDone }: { onDone: (start: boolean) => void }) {
  const [[step, dir], setStep] = useState<[number, number]>([0, 1]);
  const last = step === STEPS.length - 1;
  const go = (next: number) => {
    if (next < 0 || next >= STEPS.length) return;
    setStep([next, next > step ? 1 : -1]);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") go(step + 1);
      if (event.key === "ArrowLeft") go(step - 1);
      if (event.key === "Escape") onDone(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const Scene = SCENES[step]!;
  const current = STEPS[step]!;

  return (
    <motion.div
      className="welcome-bg"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.25 } }}
    >
      <motion.div
        className="welcome"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        initial={{ opacity: 0, transform: "translateY(24px) scale(0.96)" }}
        animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
        exit={{ opacity: 0, transform: "translateY(12px) scale(0.98)", transition: { duration: 0.2 } }}
        transition={{ type: "spring", duration: 0.6, bounce: 0.18 }}
      >
        <button type="button" className="icon-btn welcome-close" aria-label="Close welcome" onClick={() => onDone(false)}>
          <Icon name="close" size={16} />
        </button>
        <div className="welcome-stage">
          <AnimatePresence mode="popLayout" custom={dir} initial={false}>
            <motion.div
              key={step}
              className="welcome-scene"
              custom={dir}
              initial={{ opacity: 0, x: dir * 60, filter: "blur(4px)" }}
              animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, x: dir * -60, filter: "blur(4px)" }}
              transition={{ type: "spring", duration: 0.5, bounce: 0.1 }}
            >
              <Scene />
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="welcome-copy">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
            >
              <h1 id="welcome-title">{current.title}</h1>
              <p>{current.body}</p>
            </motion.div>
          </AnimatePresence>
          <div className="welcome-foot">
            <div className="dots" role="tablist" aria-label="Welcome steps">
              {STEPS.map((s, i) => (
                <button
                  key={s.title}
                  type="button"
                  role="tab"
                  aria-selected={i === step}
                  aria-label={`Step ${i + 1}: ${s.title}`}
                  className={i === step ? "on" : ""}
                  onClick={() => go(i)}
                >
                  {i === step ? <motion.i layoutId="welcome-dot" transition={spring} /> : null}
                </button>
              ))}
            </div>
            <div className="welcome-actions">
              {step > 0 ? (
                <button type="button" className="btn btn-quiet" onClick={() => go(step - 1)}>
                  Back
                </button>
              ) : (
                <button type="button" className="btn btn-quiet" onClick={() => onDone(false)}>
                  Skip welcome
                </button>
              )}
              <button type="button" className="btn btn-primary" onClick={() => (last ? onDone(true) : go(step + 1))}>
                {last ? "Get started" : "Next"}
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
