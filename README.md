# 부동산 가격 조회 사이트

지도에서 위치를 눌러 **관심 위치로 저장**하면 필지의 **개별공시지가**, 같은 지번의 **최근 아파트 실거래**, 지역별 **한국부동산원 주간 가격 변동률**을 보여 주고, 매주 금요일 아침 자동으로 기록을 쌓습니다.

## 구성
- `index.html` : 화면 (GitHub Pages로 게시)
- `supabase/schema.sql` : 테이블 3개 (관심 위치, 주간 기록, 지역 주간 동향)
- `supabase/functions/realestate/index.ts` : 공공 API 중계·저장 함수
- `.github/workflows/weekly.yml` : 매주 자동 기록

## 설치 순서
1. **API 키 3가지 발급** (모두 무료)
   - 브이월드(vworld.kr) 오픈API 인증키 → 공시지가·필지 조회 (서비스 URL에 게시할 GitHub Pages 주소 입력)
   - 공공데이터포털(data.go.kr) → "국토교통부_아파트 매매 실거래가 자료" 활용신청 → 일반 인증키
   - 한국부동산원 R-ONE(reb.or.kr/r-one) → Open API 인증키, 그리고 명세서에서 **주간 아파트 매매·전세 가격 변동률 통계표 ID(STATBL_ID)** 확인
2. Supabase SQL Editor에서 `supabase/schema.sql` 실행
3. 함수 비밀값 등록 후 배포
   ```
   supabase secrets set APP_PASSWORD=사이트비밀번호 VWORLD_KEY=... VWORLD_DOMAIN=깃허브페이지주소(예: 계정.github.io) \
     DATA_GO_KR_KEY=... REB_KEY=... REB_SALE_STATBL_ID=... REB_JEONSE_STATBL_ID=...
   supabase functions deploy realestate --no-verify-jwt
   ```
4. GitHub 저장소에 올리고 Settings → Pages 켜기, Settings → Secrets → `APP_PASSWORD` 등록 (자동 기록용)
5. 사이트 접속 → 비밀번호 입력 → 지도에서 위치 선택 → 저장

## 알아 둘 점
- 공시지가 단위는 **원/㎡**이며, 1평(3.305785㎡)당 금액은 환산값입니다.
- 실거래가는 신고 지연으로 최대 30일 늦게 반영되며, **같은 지번의 아파트 매매**만 표시합니다. 토지·단독주택 지번은 거래가 없다고 나옵니다.
- 한국부동산원 주간 동향은 지번별이 아니라 시·군·구 단위 통계입니다.
- 한국부동산원 통계표 ID가 없으면 지역 주간 동향은 비어 있고, 공시지가·실거래는 정상 동작합니다.
- 비밀번호를 아는 사람만 저장·조회할 수 있습니다.
