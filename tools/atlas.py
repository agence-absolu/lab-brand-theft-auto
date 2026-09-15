import zlib, struct, sys

def read_png(p):
    d=open(p,'rb').read(); pos=8; idat=b''; w=h=None
    while pos<len(d):
        ln=struct.unpack('>I',d[pos:pos+4])[0]; t=d[pos+4:pos+8]; data=d[pos+8:pos+8+ln]
        if t==b'IHDR': w,h,bd,ct=struct.unpack('>IIBB',data[:10]); assert bd==8 and ct==6,(bd,ct)
        if t==b'IDAT': idat+=data
        pos+=12+ln
    raw=zlib.decompress(idat); stride=w*4
    out=bytearray(h*stride); prev=bytearray(stride); i=0
    for y in range(h):
        f=raw[i]; i+=1
        line=bytearray(raw[i:i+stride]); i+=stride
        for x in range(stride):
            a=line[x-4] if x>=4 else 0
            b=prev[x]; c=prev[x-4] if x>=4 else 0
            if f==1: line[x]=(line[x]+a)&255
            elif f==2: line[x]=(line[x]+b)&255
            elif f==3: line[x]=(line[x]+(a+b)//2)&255
            elif f==4:
                pp=a+b-c; pa=abs(pp-a); pb=abs(pp-b); pc=abs(pp-c)
                pr=a if (pa<=pb and pa<=pc) else (b if pb<=pc else c)
                line[x]=(line[x]+pr)&255
        out[y*stride:(y+1)*stride]=line; prev=line
    return w,h,out

def write_png(p,w,h,px):
    raw=bytearray()
    for y in range(h):
        raw.append(0); raw+=px[y*w*4:(y+1)*w*4]
    def chunk(t,d):
        c=struct.pack('>I',len(d))+t+d
        return c+struct.pack('>I', zlib.crc32(t+d)&0xffffffff)
    out=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,6,0,0,0))
    out+=chunk(b'IDAT',zlib.compress(bytes(raw),9))+chunk(b'IEND',b'')
    open(p,'wb').write(out)

def alpha(px,w,x,y): return px[(y*w+x)*4+3]

def segment(px,w,h,x0,x1,y0,y1,gap=10,minw=12):
    """Colonnes occupées -> plages, en fusionnant celles séparées de moins de `gap`."""
    occupied=[any(alpha(px,w,x,y)>12 for y in range(y0,y1)) for x in range(x0,x1)]
    runs=[]; start=None
    for i,v in enumerate(occupied):
        if v and start is None: start=i
        elif not v and start is not None: runs.append([start,i]); start=None
    if start is not None: runs.append([start,len(occupied)])
    merged=[]
    for r in runs:
        if merged and r[0]-merged[-1][1] < gap: merged[-1][1]=r[1]
        else: merged.append(r)
    return [(x0+a,x0+b) for a,b in merged if b-a>=minw]

def bbox(px,w,x0,x1,y0,y1):
    minx,maxx,miny,maxy=x1,x0,y1,y0
    for y in range(y0,y1):
        for x in range(x0,x1):
            if alpha(px,w,x,y)>12:
                if x<minx: minx=x
                if x>maxx: maxx=x
                if y<miny: miny=y
                if y>maxy: maxy=y
    return minx,miny,maxx+1,maxy+1

def build(src,dst,cols,rows=1):
    """Re-decoupe une planche en cellules uniformes, puis recompose un atlas
    propre : chaque vignette est recadree sur son contenu, centree, et calee
    en bas. Les frames se superposent donc parfaitement d'une image a l'autre."""
    w,h,px=read_png(src)
    cw0,ch0=w/cols,h/rows
    boxes=[]
    for r in range(rows):
        for c in range(cols):
            x0,x1=round(c*cw0),round((c+1)*cw0)
            y0,y1=round(r*ch0),round((r+1)*ch0)
            b=bbox(px,w,x0,x1,y0,y1)
            if b[2]<=b[0] or b[3]<=b[1]:
                raise SystemExit('cellule vide en r%d c%d : mauvais decoupage' % (r,c))
            boxes.append(b)

    cw=max(b[2]-b[0] for b in boxes)
    ch=max(b[3]-b[1] for b in boxes)
    n=len(boxes)
    ow=cw*n
    out=bytearray(ow*ch*4)
    for i,(x0,y0,x1,y1) in enumerate(boxes):
        fw,fh=x1-x0,y1-y0
        ox=i*cw+(cw-fw)//2   # centre horizontalement
        oy=ch-fh             # cale en bas : la fumee part toujours du meme point
        for y in range(fh):
            s0=((y0+y)*w+x0)*4
            d0=((oy+y)*ow+ox)*4
            out[d0:d0+fw*4]=px[s0:s0+fw*4]
    write_png(dst,ow,ch,out)
    print(dst,'frames',n,'cellule',cw,'x',ch)
    return n

if __name__=='__main__':
    import sys
    src, dst, cols, rows = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    build(src, dst, cols, rows)
