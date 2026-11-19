#!/usr/bin/env python3
"""Extraction des projets d'agence-absolu.com vers les données du jeu.

Le script qui avait produit les projets lmwr.fr n'a jamais été versionné et a
disparu avec lui : impossible de rejouer l'extraction ou de la corriger. Celui-ci
l'est, et il est idempotent — on peut le relancer pour rafraîchir un projet.

  python3 tools/absolu-projects.py --dry-run   relève sans rien télécharger
  python3 tools/absolu-projects.py             télécharge, transcode, génère

Les masters du site font 1080x1920 à 60 i/s et 15 Mbit/s : sur un panneau vu
depuis une voiture, tout cela part à la poubelle du GPU. On en tire deux
encodages, l'un pour les panneaux, l'autre pour les plans de l'espace blanc.
"""
import argparse, html as H, json, re, shutil, subprocess, sys
from pathlib import Path

BASE = "https://agence-absolu.com"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0 Safari/537.36")
SLUGS = ["martinique-tourisme", "parrot-world", "vins-de-loire", "mr-bricolage",
         "aluclos", "le-guerandais", "noirmoutier-tourisme",
         "sao-tome-et-principe", "le-monde-de-noe", "les-arcs"]

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public" / "projects"

# Panneaux : les sources sont verticales (9:16) et le panneau est en 16:9.
# coverTexture recadre à l'affichage, donc encoder la hauteur entière revient
# à payer 68 % de pixels qui seront jetés. On recadre ici une bonne fois : à
# poids trois fois moindre, la bande conservée est plus définie qu'avant.
PANEL_VF, PANEL_CRF = "crop=iw:iw*9/16,scale=640:-2,fps=24", "30"
# Plans de l'espace blanc : regardés de près et à l'arrêt, donc plus généreux.
PLANE_VF, PLANE_CRF = "scale=-2:720,fps=30", "26"
# Images : mêmes réglages que la galerie lmwr (webp, 1600 px max, q78).
IMG_MAX, IMG_Q = 1600, "78"


def fetch(url: str) -> str:
    out = subprocess.run(["curl", "-sL", "-A", UA, url], capture_output=True)
    return out.stdout.decode("utf8", "replace")


def text_of(fragment: str) -> str:
    return H.unescape(re.sub(r"<[^>]+>", " ", fragment))


def clean(s: str) -> str:
    """Les balises sont remplacées par une espace pour ne pas souder les mots,
    ce qui en laisse traîner devant la ponctuation et après les apostrophes
    quand le texte porte de l'emphase en plein milieu d'un mot."""
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"\s+([,.;:!?%\u00bb])", r"\1", s)   # espace avant ponctuation
    s = re.sub(r"([\u2019'\u00ab])\s+", r"\1", s)  # espace après apostrophe
    return s.replace("\u00ab", "\u00ab ").strip()


def parse(slug: str) -> dict:
    """Relève un projet. Tout est borné au contenu principal : la page porte
    aussi les teasers des projets voisins, qui amèneraient leurs médias ici."""
    page = fetch(f"{BASE}/projets/{slug}")
    if "<main" not in page:
        raise SystemExit(f"{slug} : page inattendue (pas de <main>)")
    body = page[page.index("<main"):]
    end = body.find("NodeProjectRelated")
    if end > 0:
        body = body[:end]

    name = re.search(r'class="NodeProject-title[^"]*"[^>]*>(.*?)</', body, re.S)
    baseline = re.search(r"<h2[^>]*>(.*?)</h2>", body, re.S)
    tags = re.findall(r'class="NodeExpertiseMicro[^"]*"[^>]*>(.*?)</div>', body, re.S)

    videos = []
    for v in re.findall(r'/sites/default/files/[^"\' ]*\.mp4', body):
        if v not in videos:          # ordre du DOM conservé : la première est l'en-tête
            videos.append(v)

    # Les vidéos vivent sous le même préfixe media-* : on ne garde ici que ce
    # qui porte une extension d'image, sans quoi on tenterait de convertir les
    # MP4 du projet en WebP.
    images = []
    for i in re.findall(
            r'/sites/default/files/(?:styles/[^/]+/public/)?'
            r'(media-[a-z-]+/[^"\' ?]+\.(?:jpe?g|png|webp|gif))', body, re.I):
        src = "/sites/default/files/" + re.sub(r"\.webp$", "", i)
        if src.lower().endswith(".mp4") or src in images:
            continue
        images.append(src)

    return {
        "slug": slug,
        "name": clean(text_of(name.group(1))) if name else slug,
        "title": clean(text_of(baseline.group(1))) if baseline else "",
        "url": f"{BASE}/projets/{slug}",
        "tags": [clean(text_of(t)) for t in tags if clean(text_of(t))],
        "videos": videos,
        "images": images,
    }


def run(cmd: list) -> bool:
    done = subprocess.run(cmd, capture_output=True)
    if done.returncode:
        print("    ! " + done.stderr.decode("utf8", "replace").strip().split("\n")[-1])
    return done.returncode == 0


def transcode(url: str, dest: Path, vf: str, crf: str) -> bool:
    """ffmpeg lit l'URL directement : le master de 40 Mo ne touche jamais le disque."""
    if dest.exists():
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    return run(["ffmpeg", "-y", "-v", "error", "-user_agent", UA, "-i", url,
                "-an", "-vf", vf, "-c:v", "libx264", "-crf", crf,
                "-preset", "veryfast", "-movflags", "+faststart", str(dest)])


def convert_image(url: str, dest: Path) -> bool:
    """ffmpeg n'embarque pas forcément libwebp — ce n'est pas le cas ici — donc
    la conversion passe par ImageMagick, qui lui travaille sur fichier."""
    if dest.exists():
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    # L'extension d'origine est conservée : ImageMagick détecte le format par
    # elle, et un suffixe neutre lui fait refuser le fichier.
    ext = re.search(r"\.[A-Za-z0-9]+$", url)
    tmp = dest.with_suffix(".src" + (ext.group(0).lower() if ext else ".bin"))
    if not run(["curl", "-sL", "-A", UA, "--fail", url, "-o", str(tmp)]):
        tmp.unlink(missing_ok=True)
        return False
    ok = run(["magick", str(tmp), "-resize", f"{IMG_MAX}x{IMG_MAX}>",
              "-quality", IMG_Q, str(dest)])
    tmp.unlink(missing_ok=True)
    return ok


def poster_from(video: Path, dest: Path) -> bool:
    """Le poster est tiré de la vidéo elle-même : il colle donc toujours à ce
    qui va s'afficher, là où une vignette du site pouvait montrer autre chose."""
    if dest.exists():
        return True
    return run(["ffmpeg", "-y", "-v", "error", "-i", str(video),
                "-vf", "thumbnail,scale=-2:720", "-frames:v", "1", str(dest)])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    projects = [parse(s) for s in SLUGS]

    print(f"{'projet':<22} {'vidéos':>7} {'images':>7}   titre")
    for p in projects:
        print(f"{p['slug']:<22} {len(p['videos']):>7} {len(p['images']):>7}   "
              f"{p['name']} — {p['title'][:50]}")
    if args.dry_run:
        (ROOT / "projects" / "absolu.json").write_text(
            json.dumps({"source": f"{BASE}/projets", "projects": projects},
                       ensure_ascii=False, indent=1), encoding="utf8")
        print("\nrelevé écrit dans projects/absolu.json (rien téléchargé)")
        return

    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg est requis")

    out = []
    media, planes = {}, {}
    for p in projects:
        print(f"\n{p['slug']}")
        if not p["videos"]:
            print("    ! aucune vidéo, projet ignoré")
            continue

        panel = PUBLIC / f"{p['slug']}.mp4"
        print(f"  panneau   {p['videos'][0].rsplit('/', 1)[-1]}")
        if not transcode(BASE + p["videos"][0], panel, PANEL_VF, PANEL_CRF):
            continue
        poster = PUBLIC / f"{p['slug']}.jpg"
        poster_from(panel, poster)

        # Toutes les vidéos du projet peuplent l'espace blanc, en-tête comprise
        plane_list = []
        for i, v in enumerate(p["videos"]):
            dest = PUBLIC / "light" / p["slug"] / f"video-{i:02d}.mp4"
            if transcode(BASE + v, dest, PLANE_VF, PLANE_CRF):
                plane_list.append(f"/projects/light/{p['slug']}/video-{i:02d}.mp4")
        print(f"  plans     {len(plane_list)} vidéos")

        image_list = []
        for i, src in enumerate(p["images"]):
            base = re.sub(r"\.[a-z0-9]+$", "", src.rsplit("/", 1)[-1].lower())
            stem = re.sub(r"[^a-z0-9]+", "-", base).strip("-")[:48]
            dest = PUBLIC / "light" / p["slug"] / f"{i:02d}-{stem}.webp"
            if convert_image(BASE + src, dest):
                image_list.append(f"/projects/light/{p['slug']}/{dest.name}")
        print(f"  images    {len(image_list)}")

        media[p["slug"]] = image_list
        planes[p["slug"]] = plane_list
        out.append({"slug": p["slug"], "name": p["name"], "title": p["title"],
                    "url": p["url"], "tags": p["tags"],
                    "poster": f"/projects/{p['slug']}.jpg",
                    "video": f"/projects/{p['slug']}.mp4"})

    write_sources(out, media, planes)


def write_sources(projects: list, media: dict, planes: dict) -> None:
    src = ROOT / "src"
    lines = [
        "// Projets d'agence-absolu.com, affichés sur les panneaux de la ville.",
        "// Généré par tools/absolu-projects.py — ne pas éditer à la main.",
        "// `name` est le nom court, peint sur le panneau ; `title` est la",
        "// baseline, composée en grand dans l'espace blanc du projet.",
        "export const PROJECTS = [",
    ]
    for p in projects:
        lines.append("  " + json.dumps(p, ensure_ascii=False) + ",")
    lines.append("]\n")
    (src / "projects.js").write_text("\n".join(lines), encoding="utf8")

    lines = [
        "// Médias secondaires de chaque projet, en WebP allégé (dossier light/).",
        "// Généré par tools/absolu-projects.py — ne pas éditer à la main.",
        "// Un plan flottant est créé par média dans l'espace blanc du projet.",
        f"export const PROJECT_MEDIA = {json.dumps(media, ensure_ascii=False, indent=1)}",
        "",
        "// Vidéos du projet, transcodées en MP4 local. Elles remplacent les flux",
        "// HLS distants de l'ancienne version : plus de dépendance réseau, et un",
        "// poids maîtrisé puisqu'on encode nous-mêmes.",
        f"export const PROJECT_STREAMS = {json.dumps(planes, ensure_ascii=False, indent=1)}",
        "",
    ]
    (src / "project-media.js").write_text("\n".join(lines), encoding="utf8")
    print(f"\nécrit : src/projects.js ({len(projects)} projets), src/project-media.js")


if __name__ == "__main__":
    main()
