"""Isole un téléphone de la collection : regroupe les groupes OBJ par
proximité au sol (chaque téléphone est un îlot), puis exporte l'îlot demandé."""
import sys

SRC = "/Users/bjoly/Downloads/73-mobile-phones-evolution/MOBILE PHONES EVOLUTION OBJ.obj"

def parse(path):
    verts, norms, uvs = [], [], []
    groups, cur = {}, None
    for line in open(path, errors='ignore'):
        p = line.split()
        if not p: continue
        if p[0] == 'v': verts.append(tuple(float(v) for v in p[1:4]))
        elif p[0] == 'vn': norms.append(tuple(float(v) for v in p[1:4]))
        elif p[0] == 'vt': uvs.append(tuple(float(v) for v in p[1:3]))
        elif p[0] in ('g', 'o'):
            cur = ' '.join(p[1:]); groups.setdefault(cur, {'faces': [], 'mtl': None})
        elif p[0] == 'usemtl' and cur: groups[cur]['mtl'] = p[1]
        elif p[0] == 'f' and cur: groups[cur]['faces'].append(p[1:])
    return verts, norms, uvs, groups

def bbox(verts, faces):
    idx = [int(t.split('/')[0]) for f in faces for t in f]
    idx = [i - 1 if i > 0 else len(verts) + i for i in idx]
    xs = [verts[i][0] for i in idx]; ys = [verts[i][1] for i in idx]; zs = [verts[i][2] for i in idx]
    return min(xs), min(ys), min(zs), max(xs), max(ys), max(zs)

def clusters(boxes, gap=55):
    """Fusionne les groupes dont les emprises au sol (X/Z) se touchent."""
    items = list(boxes.items())
    parent = {k: k for k, _ in items}
    def find(a):
        while parent[a] != a: parent[a] = parent[parent[a]]; a = parent[a]
        return a
    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb: parent[ra] = rb
    for i, (ka, a) in enumerate(items):
        for kb, b in items[i + 1:]:
            near_x = a[0] - gap < b[3] and b[0] - gap < a[3]
            near_z = a[2] - gap < b[5] and b[2] - gap < a[5]
            if near_x and near_z: union(ka, kb)
    out = {}
    for k, _ in items: out.setdefault(find(k), []).append(k)
    return list(out.values())

def export(path, verts, norms, uvs, groups, names):
    """Réécrit un OBJ ne contenant que les groupes demandés, réindexé."""
    used_v, used_n, used_t = {}, {}, {}
    lines = []
    for g in names:
        lines.append(f'g {g}')
        if groups[g]['mtl']: lines.append(f"usemtl {groups[g]['mtl']}")
        for face in groups[g]['faces']:
            toks = []
            for t in face:
                parts = (t.split('/') + ['', ''])[:3]
                vi = int(parts[0]); vi = vi - 1 if vi > 0 else len(verts) + vi
                if vi not in used_v: used_v[vi] = len(used_v) + 1
                tok = str(used_v[vi])
                ti = parts[1]; ni = parts[2]
                if ti:
                    j = int(ti); j = j - 1 if j > 0 else len(uvs) + j
                    if j not in used_t: used_t[j] = len(used_t) + 1
                    tok += '/' + str(used_t[j])
                elif ni: tok += '/'
                if ni:
                    j = int(ni); j = j - 1 if j > 0 else len(norms) + j
                    if j not in used_n: used_n[j] = len(used_n) + 1
                    tok += '/' + str(used_n[j])
                toks.append(tok)
            lines.append('f ' + ' '.join(toks))

    head = []
    for src, used, tag in ((verts, used_v, 'v'), (uvs, used_t, 'vt'), (norms, used_n, 'vn')):
        for i, _ in sorted(used.items(), key=lambda kv: kv[1]):
            head.append(tag + ' ' + ' '.join(f'{c:.5f}' for c in src[i]))
    open(path, 'w').write('\n'.join(head + lines) + '\n')
    print(path, len(used_v), 'sommets,', len(names), 'groupes')

if __name__ == '__main__':
    verts, norms, uvs, groups = parse(SRC)
    boxes = {g: bbox(verts, d['faces']) for g, d in groups.items() if d['faces']}
    boxes = {g: b for g, b in boxes.items() if g not in ('Plane01', 'Plane06')}  # sol et fond
    cl = clusters(boxes, 0)
    infos = []
    for names in cl:
        bs = [boxes[n] for n in names]
        b = (min(x[0] for x in bs), min(x[1] for x in bs), min(x[2] for x in bs),
             max(x[3] for x in bs), max(x[4] for x in bs), max(x[5] for x in bs))
        infos.append((b, names))
    infos.sort(key=lambda it: (round(it[0][2] / 100), it[0][0]))  # même ordre que silhouette.py
    for i, (b, names) in enumerate(infos):
        w, h, d = b[3] - b[0], b[4] - b[1], b[5] - b[2]
        print(f'{i:3d}  {w:7.1f} x {h:6.1f} x {d:7.1f}  ratio {d/max(w,1e-3):5.2f}  '
              f'pos({b[0]:8.1f},{b[2]:8.1f})  {len(names)} groupes')
    if len(sys.argv) > 2:
        i = int(sys.argv[1])
        export(sys.argv[2], verts, norms, uvs, groups, infos[i][1])
