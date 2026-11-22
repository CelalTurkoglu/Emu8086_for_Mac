export interface ICodeExample {
  id: string;
  titleTr: string;
  titleEn: string;
  descriptionTr: string;
  descriptionEn: string;
  /** Suggested initial Memory Viewer address when this example is selected */
  suggestedMemoryAddress: string;
  code: string;
}

export const COURSE_EXAMPLES: ICodeExample[] = [
  {
    id: 'memory-addressing',
    titleTr: '1. Doğrudan & İndisli Bellek ([0058H], [BX+DI])',
    titleEn: '1. Direct & Indexed Memory ([0058H], [BX+DI])',
    descriptionTr:
      '.model small yapısında doğrudan adresleme ([0053H], [0058H]) ve taban+indis ([BX+DI]) örneği.',
    descriptionEn:
      'Direct memory addressing ([0053H], [0058H]) and base+index ([BX+DI]) with .model small.',
    suggestedMemoryAddress: '0700:0050',
    code: `; CPE303 — Doğrudan ve Taban+İndis Adresleme
.model small
.code
main proc
    ; Doğrudan bellek yazma (DS = 0700H -> Fiziksel 07053H ve 07058H)
    ; Not: Gerçek emu8086 uyumu için BYTE PTR (veya b.) kullanılır
    MOV BYTE PTR [0053H], 12H
    MOV BYTE PTR [0058H], 04H

    ; Taban + İndis adresleme: BX + DI = 0050H + 0003H = 0053H
    MOV BX, 0050H
    MOV DI, 0003H
    MOV AL, [BX+DI]       ; AL <- 12H

    ; [0058H] adresindeki değeri topla
    ADD AL, [0058H]       ; AL <- 12H + 04H = 16H
    MOV [BX+0AH], AL      ; [005AH] <- 16H

    ; 16-bit Little-Endian bellek yazma testi
    MOV WORD PTR [005CH], 1234H
    MOV DX, [005CH]       ; DX <- 1234H (5CH=34H, 5DH=12H)

    RET
main endp
end main`,
  },
  {
    id: 'cpe303-loop',
    titleTr: '2. ORG 100h Döngü & Etiketler (CPE303: / QUIT:)',
    titleEn: '2. ORG 100h Loop & Labels (CPE303: / QUIT:)',
    descriptionTr:
      'ORG 100h altında CPE303: ve QUIT: etiketleriyle 1..5 toplamı, DEC, CMP, JNZ, JZ ve RET.',
    descriptionEn:
      'Sum 1..5 using ORG 100h with CPE303: and QUIT: labels, DEC, CMP, JNZ, JZ, and RET.',
    suggestedMemoryAddress: '0700:0050',
    code: `; CPE303 — Döngü, Etiketler ve Koşullu Dallanma
ORG 100h

    MOV CX, 0005H         ; Sayaç = 5
    MOV AX, 0000H         ; Toplam = 0

CPE303:
    ADD AX, CX            ; AX = AX + CX (5 + 4 + 3 + 2 + 1 = 15 = 000FH)
    DEC CX                ; CX = CX - 1 (ZF etkilenir, CF korunur)
    CMP CX, 0000H         ; CX == 0 mı?
    JNZ CPE303            ; Sıfır değilse CPE303 etiketine dön
    JZ  QUIT              ; Sıfırsa QUIT etiketine atla

    MOV BX, 0FFFFH        ; Bu satır çalışmamalı

QUIT:
    MOV [0050H], AX       ; Sonucu (000FH) DS:0050H adresine kaydet
    RET`,
  },
  {
    id: 'flags-check',
    titleTr: '3. Bayrak Kontrolü (O, S, Z, A, P, C)',
    titleEn: '3. Cross Flag-Register Check (O, S, Z, A, P, C)',
    descriptionTr:
      'Ders slaytlarındaki ADD, SUB, DEC ve INC bayrak değişimlerini adım adım gözlemleyin.',
    descriptionEn:
      'Step through textbook ADD, SUB, DEC, and INC examples to inspect O, S, Z, A, P, C flags.',
    suggestedMemoryAddress: '0700:0000',
    code: `; CPE303 — Aritmetik Bayrak Testi (Cross Flag-Register Check)
ORG 100h

    ; 1) 8-bit Toplama: 7FH + 01H = 80H -> OF=1, SF=1, AF=1, PF=0, CF=0
    MOV AL, 7FH
    ADD AL, 01H

    ; 2) Ders örneği: 83H + 0BH = 8EH -> SF=1, PF=1 (4 adet 1), AF=0, CF=0, OF=0
    MOV AL, 83H
    ADD AL, 0BH

    ; 3) Taşma ve Elde: FFH + 01H = 00H -> CF=1, ZF=1, AF=1, PF=1, SF=0, OF=0
    MOV BL, 0FFH
    ADD BL, 01H

    ; 4) DEC komutu CF'yi DEĞİŞTİRMEZ! (CF=1 olarak kalmalı)
    MOV CL, 01H
    DEC CL                ; CL=00H, ZF=1, PF=1, ancak CF hâlâ 1!

    ; 5) Çıkarma (Borç): 22H - 44H = DEH -> CF=1, SF=1, AF=1 (alt nibble borç), PF=1, OF=0
    MOV CH, 22H
    SUB CH, 44H

    RET`,
  },
  {
    id: 'mul-div',
    titleTr: '4. Çarpma & Bölme (MUL, DIV, IDIV)',
    titleEn: '4. Multiplication & Division (MUL, DIV, IDIV)',
    descriptionTr:
      '8-bit ve 16-bit işaretsiz MUL/DIV (DX:AX) ile işaretli IDIV sonuçlarını ve CF/OF bayraklarını inceleyin.',
    descriptionEn:
      'Inspect 8-bit and 16-bit unsigned MUL/DIV (DX:AX) and signed IDIV with CF/OF flags.',
    suggestedMemoryAddress: '0700:0000',
    code: `; CPE303 — MUL, DIV ve IDIV Komutları
ORG 100h

    ; 8-bit MUL: AX = AL * BL (20 * 15 = 300 = 012CH -> AH!=0 => CF=1, OF=1)
    MOV AL, 20
    MOV BL, 15
    MUL BL

    ; 8-bit DIV: AX / CL -> AL=Bölüm (1EH=30), AH=Kalan (00H)
    MOV CL, 10
    DIV CL

    ; 16-bit MUL: DX:AX = AX * BX (1000 * 200 = 200000 = 0003:0D40H)
    MOV AX, 1000
    MOV BX, 200
    MUL BX

    ; 16-bit DIV: DX:AX / CX -> AX=Bölüm (2000=07D0H), DX=Kalan (0)
    MOV CX, 100
    DIV CX

    ; 8-bit İşaretli IDIV: -25 / 4 -> AL=-6 (FAH), AH=-1 (FFH)
    MOV AX, -25
    MOV BL, 4
    IDIV BL

    RET`,
  },
  {
    id: 'data-scasb',
    titleTr: '5. .data Segmenti, SCASB & Konsol Çıktısı',
    titleEn: '5. .data Segment, SCASB & Console Output',
    descriptionTr:
      '.data dizisi tanımlama, @DATA, OFFSET, REPNE SCASB string arama ve INT 21H mesaj yazdırma.',
    descriptionEn:
      '.data array definitions, @DATA, OFFSET, REPNE SCASB string scan, and INT 21H console output.',
    suggestedMemoryAddress: '0700:0000',
    code: `; CPE303 — .data Segmenti, String Arama ve INT 21H
.model small
.data
    MSG   DB 'EMU8086 Mac Hazir!$'
    ARRAY DB 'A', 'B', 'C', 'D', 'E', 'F'
    LEN   EQU 6
.code
main proc
    MOV AX, @DATA
    MOV DS, AX
    MOV ES, AX

    ; INT 21H (AH=09H): '$' ile biten metni konsola yaz
    MOV DX, OFFSET MSG
    MOV AH, 09H
    INT 21H

    ; REPNE SCASB ile ARRAY içinde 'D' harfini ara
    CLD
    MOV DI, OFFSET ARRAY
    MOV CX, LEN
    MOV AL, 'D'
    REPNE SCASB           ; Bulunduğunda ZF=1, DI eşleşen baytın 1 ilerisinde

    DEC DI                ; DI artık 'D' karakterinin ofsetini gösterir
    MOV BL, [DI]          ; BL <- 'D' (44H)

    MOV AH, 4CH
    INT 21H
main endp
end main`,
  },
  {
    id: 'stack-procedure',
    titleTr: '6. Yığın (PUSH/POP) & Prosedür (CALL/RET)',
    titleEn: '6. Stack (PUSH/POP) & Procedure (CALL/RET)',
    descriptionTr:
      'CALL/RET ile alt program çağrısı ve SS:SP üzerinde PUSH/POP yığın davranışını izleyin.',
    descriptionEn:
      'Observe subroutine CALL/RET and SS:SP stack pointer updates during PUSH/POP.',
    suggestedMemoryAddress: '0700:FFF0',
    code: `; CPE303 — Yığın (Stack) ve Prosedür (CALL / RET)
.model small
.code
main proc
    MOV AX, 1111H
    MOV BX, 2222H

    ; Değerleri yığına it (SS:SP her PUSH'ta 2 azalır)
    PUSH AX
    PUSH BX

    ; Alt programı çağır (dönüş adresi yığına itilir)
    CALL TOPLA_IKI

    ; Yığından ters sırada geri al
    POP DX                ; DX <- 2222H
    POP CX                ; CX <- 1111H
    RET
main endp

TOPLA_IKI proc
    ADD AX, BX            ; AX <- 3333H
    SHL AX, 1             ; AX <- 6666H
    RET
TOPLA_IKI endp

end main`,
  },
];
