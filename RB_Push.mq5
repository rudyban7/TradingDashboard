//+------------------------------------------------------------------+
//|  RB_Push.mq5  — Pushes MT5 account + positions + deals          |
//|  Attach to any chart. Runs every 5 seconds.                      |
//+------------------------------------------------------------------+
#property copyright "RB Trading"
#property version   "1.03"
#property strict

//--- Inputs
input string PushURL    = "https://trading-dashboard-rosy.vercel.app/api/mt5/push";
input string PushSecret = "";
input int    PushEvery  = 5;

datetime lastPush = 0;

//+------------------------------------------------------------------+
int OnInit() {
   Print("RB_Push v1.03: initialised — pushing to ", PushURL, " every ", PushEvery, "s");
   EventSetTimer(PushEvery);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }
void OnTimer()                  { PushState(); }
void OnTick()                   { }

//+------------------------------------------------------------------+
void PushState() {
   // ── Account block ──
   string acct = StringFormat(
      "\"account\":{\"balance\":%.2f,\"equity\":%.2f,\"margin\":%.2f,\"marginFree\":%.2f,\"marginLevel\":%.4f,\"currency\":\"%s\",\"server\":\"%s\",\"login\":%I64d}",
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoDouble(ACCOUNT_MARGIN),
      AccountInfoDouble(ACCOUNT_MARGIN_FREE),
      AccountInfoDouble(ACCOUNT_MARGIN_LEVEL),
      AccountInfoString(ACCOUNT_CURRENCY),
      AccountInfoString(ACCOUNT_SERVER),
      AccountInfoInteger(ACCOUNT_LOGIN)
   );

   // ── Open positions ──
   int total = PositionsTotal();
   string posArr = "[";
   for (int i = 0; i < total; i++) {
      ulong ticket = PositionGetTicket(i);
      if (ticket == 0) continue;
      if (!PositionSelectByTicket(ticket)) continue;
      string sym     = PositionGetString(POSITION_SYMBOL);
      int    ptype   = (int)PositionGetInteger(POSITION_TYPE);
      double vol     = PositionGetDouble(POSITION_VOLUME);
      double open    = PositionGetDouble(POSITION_PRICE_OPEN);
      double cur     = PositionGetDouble(POSITION_PRICE_CURRENT);
      double sl      = PositionGetDouble(POSITION_SL);
      double tp      = PositionGetDouble(POSITION_TP);
      double profit  = PositionGetDouble(POSITION_PROFIT);
      double swap    = PositionGetDouble(POSITION_SWAP);
      string comment = PositionGetString(POSITION_COMMENT);
      datetime openTime = (datetime)PositionGetInteger(POSITION_TIME);
      StringReplace(comment, "\"", "'");
      if (i > 0) posArr += ",";
      posArr += StringFormat(
         "{\"ticket\":%I64u,\"symbol\":\"%s\",\"type\":%d,\"volume\":%.2f,\"openPrice\":%.5f,\"currentPrice\":%.5f,\"sl\":%.5f,\"tp\":%.5f,\"profit\":%.2f,\"swap\":%.2f,\"openTime\":%I64d,\"comment\":\"%s\"}",
         ticket, sym, ptype, vol, open, cur, sl, tp, profit, swap, (long)openTime, comment
      );
   }
   posArr += "]";

   // ── Closed deals: PASS 1 — collect basic data without disrupting loop ──
   datetime histFrom = TimeCurrent() - 90 * 86400;
   HistorySelect(histFrom, TimeCurrent());
   int dealTotal = HistoryDealsTotal();

   ulong  arrTicket[];
   long   arrPosId[], arrCloseT[];
   string arrSym[], arrDir[], arrComment[];
   double arrVol[], arrCloseP[], arrProfit[], arrSwap[], arrComm[];
   int    nClose = 0;

   for (int d = 0; d < dealTotal; d++) {
      ulong t = HistoryDealGetTicket(d);
      if (t == 0) continue;
      if ((long)HistoryDealGetInteger(t, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;

      ArrayResize(arrTicket,  nClose+1); ArrayResize(arrPosId,   nClose+1);
      ArrayResize(arrSym,     nClose+1); ArrayResize(arrDir,     nClose+1);
      ArrayResize(arrComment, nClose+1); ArrayResize(arrVol,     nClose+1);
      ArrayResize(arrCloseP,  nClose+1); ArrayResize(arrProfit,  nClose+1);
      ArrayResize(arrSwap,    nClose+1); ArrayResize(arrComm,    nClose+1);
      ArrayResize(arrCloseT,  nClose+1);

      long dtype        = (long)HistoryDealGetInteger(t, DEAL_TYPE);
      arrTicket[nClose] = t;
      arrPosId[nClose]  = (long)HistoryDealGetInteger(t, DEAL_POSITION_ID);
      arrSym[nClose]    = HistoryDealGetString(t, DEAL_SYMBOL);
      arrDir[nClose]    = (dtype == DEAL_TYPE_SELL) ? "buy" : "sell";
      arrVol[nClose]    = HistoryDealGetDouble(t, DEAL_VOLUME);
      arrCloseP[nClose] = HistoryDealGetDouble(t, DEAL_PRICE);
      arrProfit[nClose] = HistoryDealGetDouble(t, DEAL_PROFIT);
      arrSwap[nClose]   = HistoryDealGetDouble(t, DEAL_SWAP);
      arrComm[nClose]   = HistoryDealGetDouble(t, DEAL_COMMISSION);
      arrCloseT[nClose] = (long)HistoryDealGetInteger(t, DEAL_TIME);
      string c = HistoryDealGetString(t, DEAL_COMMENT);
      StringReplace(c, "\"", "'");
      arrComment[nClose] = c;
      nClose++;
   }

   // ── PASS 2 — enrich with open price + SL (safe: no outer loop dependency) ──
   string dealsArr = "[";
   int dealCount = 0;

   for (int i = 0; i < nClose; i++) {
      double openP = 0, slP = 0, riskUSD = 0;
      long   openT = 0;

      HistorySelectByPosition(arrPosId[i]);
      int np = HistoryDealsTotal();
      for (int pd = 0; pd < np; pd++) {
         ulong pdtick = HistoryDealGetTicket(pd);
         if (pdtick == 0) continue;
         if ((long)HistoryDealGetInteger(pdtick, DEAL_ENTRY) == DEAL_ENTRY_IN) {
            openP = HistoryDealGetDouble(pdtick, DEAL_PRICE);
            openT = (long)HistoryDealGetInteger(pdtick, DEAL_TIME);
            break;
         }
      }
      int no = HistoryOrdersTotal();
      for (int o = 0; o < no; o++) {
         ulong otick = HistoryOrderGetTicket(o);
         long  otype = (long)HistoryOrderGetInteger(otick, ORDER_TYPE);
         if (otype == ORDER_TYPE_BUY || otype == ORDER_TYPE_SELL) {
            slP = HistoryOrderGetDouble(otick, ORDER_SL);
            break;
         }
      }
      if (slP > 0 && openP > 0 && arrVol[i] > 0) {
         ENUM_ORDER_TYPE ot = (arrDir[i] == "buy") ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
         double calcRisk = 0;
         OrderCalcProfit(ot, arrSym[i], arrVol[i], openP, slP, calcRisk);
         riskUSD = MathAbs(calcRisk);
      }

      if (dealCount > 0) dealsArr += ",";
      dealsArr += StringFormat(
         "{\"ticket\":%I64u,\"posId\":%I64d,\"symbol\":\"%s\",\"dir\":\"%s\",\"volume\":%.2f,\"closePrice\":%.5f,\"openPrice\":%.5f,\"slPrice\":%.5f,\"riskUSD\":%.2f,\"profit\":%.2f,\"swap\":%.2f,\"commission\":%.2f,\"openTime\":%I64d,\"closeTime\":%I64d,\"comment\":\"%s\"}",
         arrTicket[i], arrPosId[i], arrSym[i], arrDir[i], arrVol[i], arrCloseP[i],
         openP, slP, riskUSD, arrProfit[i], arrSwap[i], arrComm[i], openT, arrCloseT[i], arrComment[i]
      );
      dealCount++;
   }
   dealsArr += "]";

   // ── Build + send ──
   string url  = PushURL;
   if (StringLen(PushSecret) > 0) url += "?secret=" + PushSecret;
   string body = "{" + acct + ",\"positions\":" + posArr + ",\"deals\":" + dealsArr + "}";

   char   postData[], result[];
   string resultHeaders;
   StringToCharArray(body, postData, 0, StringLen(body));

   int statusCode = WebRequest("POST", url, "Content-Type: application/json\r\n", 5000, postData, result, resultHeaders);

   if (statusCode == 200) {
      Print("RB_Push: OK [", TimeToString(TimeCurrent(), TIME_DATE|TIME_MINUTES|TIME_SECONDS), "] positions=", total, " deals=", dealCount);
   } else {
      Print("RB_Push: ERROR status=", statusCode, " resp=", CharArrayToString(result));
   }
}
//+------------------------------------------------------------------+
