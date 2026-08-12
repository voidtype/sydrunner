# Station scorecard

Written by `server/station-suite.ts`, coarse sweep, 60.4 s. Ordered by distance from Central: **this is the work queue**, and it is worked from the top.

Columns are the seven checks. `n/a` means the station has no platform to ask about
(nothing calls there); `skip` means it is outside the built extent.

| # | station | km | served | reach | stand | holes | clear | ttt | tworld | vert |
|---:|---|---:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| 1 | Central | 0.00 | yes | **X** | **X** | **X** | **X** | **X** | **X** | ok |
| 2 | Central Chalmers Street | 0.12 | no | n/a | n/a | **X** | **X** | **X** | **X** | **X** |
| 3 | Central Grand Concourse | 0.23 | no | n/a | n/a | **X** | **X** | **X** | **X** | ok |
| 4 | Haymarket | 0.35 | no | n/a | n/a | **X** | n/a | **X** | **X** | **X** |
| 5 | Capitol Square | 0.52 | no | n/a | n/a | **X** | n/a | ok | **X** | ok |
| 6 | Surry Hills | 0.65 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 7 | Chinatown | 0.65 | no | n/a | n/a | **X** | n/a | **X** | n/a | ok |
| 8 | Paddy's Markets | 0.66 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 9 | Museum | 1.01 | yes | **X** | ok | **X** | n/a | **X** | n/a | ok |
| 10 | Exhibition Centre | 1.01 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 11 | Redfern | 1.13 | yes | ok | **X** | **X** | ok | **X** | **X** | **X** |
| 12 | Town Hall | 1.19 | yes | ok | ok | **X** | n/a | **X** | n/a | **X** |
| 13 | Gadigal | 1.19 | yes | **X** | ok | **X** | n/a | **X** | n/a | ok |
| 14 | QVB | 1.43 | no | n/a | n/a | **X** | n/a | **X** | n/a | ok |
| 15 | Convention | 1.53 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 16 | Waterloo | 1.57 | yes | **X** | ok | ok | n/a | ok | n/a | ok |
| 17 | St James | 1.59 | yes | **X** | ok | **X** | n/a | **X** | n/a | ok |
| 18 | Wentworth Park | 1.60 | no | n/a | n/a | ok | n/a | ok | n/a | **X** |
| 19 | Moore Park | 1.75 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 20 | Kings Cross | 1.83 | yes | **X** | **X** | **X** | **X** | ok | **X** | **X** |
| 21 | Pyrmont Bay | 1.86 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 22 | Martin Place | 1.90 | yes | **X** | **X** | **X** | n/a | **X** | n/a | **X** |
| 23 | Glebe | 1.93 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 24 | Bank Street | 1.98 | no | n/a | n/a | ok | n/a | ok | n/a | **X** |
| 25 | Wynyard | 2.00 | yes | ok | **X** | **X** | n/a | **X** | n/a | **X** |
| 26 | The Star | 2.13 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 27 | Bridge Street | 2.26 | no | n/a | n/a | **X** | n/a | **X** | n/a | **X** |
| 28 | John Street Square | 2.31 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 29 | Macdonaldtown | 2.34 | yes | ok | **X** | **X** | ok | **X** | **X** | ok |
| 30 | Green Square | 2.44 | yes | **X** | **X** | **X** | n/a | **X** | n/a | ok |
| 31 | Circular Quay | 2.59 | yes | ok | **X** | **X** | **X** | **X** | **X** | **X** |
| 32 | Erskineville | 2.67 | yes | ok | ok | **X** | **X** | **X** | **X** | **X** |
| 33 | Jubilee Park | 2.75 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 34 | Barangaroo | 2.78 | yes | **X** | ok | **X** | n/a | ok | n/a | **X** |
| 35 | Edgecliff | 2.81 | yes | **X** | **X** | **X** | **X** | ok | **X** | **X** |
| 36 | ES Marks | 2.86 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 37 | Newtown | 2.88 | yes | ok | **X** | **X** | **X** | **X** | **X** | **X** |
| 38 | Royal Randwick | 3.10 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 39 | Kensington | 3.18 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 40 | Rozelle Bay | 3.41 | no | n/a | n/a | ok | n/a | ok | n/a | **X** |
| 41 | St Peters | 3.48 | yes | ok | **X** | **X** | **X** | ok | **X** | ok |
| 42 | Wansey Road | 3.93 | no | n/a | n/a | ok | n/a | ok | n/a | **X** |
| 43 | Bondi Junction | 3.95 | yes | **X** | **X** | **X** | n/a | ok | n/a | ok |
| 44 | Lilyfield | 3.99 | no | n/a | n/a | ok | n/a | ok | n/a | **X** |
| 45 | UNSW Anzac Parade | 4.00 | no | n/a | n/a | ok | n/a | ok | n/a | **X** |
| 46 | Stanmore | 4.09 | yes | ok | ok | **X** | **X** | **X** | **X** | **X** |
| 47 | Milsons Point | 4.31 | yes | ok | **X** | **X** | **X** | ok | **X** | **X** |
| 48 | UNSW High Street | 4.45 | no | n/a | n/a | ok | n/a | ok | n/a | **X** |
| 49 | Kingsford | 4.55 | no | n/a | n/a | ok | n/a | ok | n/a | **X** |
| 50 | Mascot | 4.65 | yes | **X** | ok | ok | n/a | ok | n/a | ok |
| 51 | North Sydney | 4.80 | yes | ok | **X** | **X** | ok | ok | **X** | **X** |
| 52 | Randwick | 4.81 | no | n/a | n/a | ok | n/a | ok | n/a | **X** |
| 53 | Petersham | 4.84 | yes | ok | ok | **X** | **X** | **X** | **X** | **X** |
| 54 | Leichhardt North | 4.95 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 55 | Juniors Kingsford | 4.97 | no | n/a | n/a | ok | n/a | ok | n/a | **X** |
| 56 | Sydenham | 5.02 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 57 | Waverton | 5.20 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 58 | Victoria Cross | 5.36 | yes | ok | ok | **X** | n/a | ok | n/a | **X** |
| 59 | Hawthorne | 5.50 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 60 | Lewisham | 5.52 | yes | ok | ok | **X** | **X** | **X** | **X** | **X** |
| 61 | Marion | 5.67 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 62 | Taverners Hill | 5.68 | no | n/a | n/a | **X** | n/a | **X** | n/a | **X** |
| 63 | Marrickville | 5.88 | yes | ok | ok | **X** | ok | ok | **X** | **X** |
| 64 | Lewisham West | 5.92 | no | n/a | n/a | **X** | ok | **X** | ok | **X** |
| 65 | Domestic Airport | 5.95 | yes | **X** | ok | ok | n/a | ok | n/a | ok |
| 66 | Wollstonecraft | 6.00 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 67 | Summer Hill | 6.29 | yes | ok | **X** | **X** | **X** | **X** | ok | ok |
| 68 | Waratah Mills | 6.33 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 69 | Tempe | 6.41 | yes | ok | ok | **X** | **X** | ok | **X** | ok |
| 70 | Crows Nest | 6.54 | yes | ok | ok | **X** | n/a | ok | n/a | ok |
| 71 | Arlington | 6.61 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 72 | Dulwich Grove | 6.64 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 73 | International Airport | 6.74 | yes | **X** | ok | **X** | n/a | ok | n/a | ok |
| 74 | Dulwich Hill | 6.77 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 75 | Wolli Creek | 6.89 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 76 | St Leonards | 6.97 | yes | ok | ok | **X** | ok | ok | **X** | **X** |
| 77 | Ashfield | 7.46 | yes | ok | ok | **X** | **X** | **X** | **X** | ok |
| 78 | Hurlstone Park | 7.49 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 79 | Arncliffe | 7.94 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 80 | Turrella | 7.95 | yes | ok | ok | **X** | ok | ok | **X** | **X** |
| 81 | Croydon | 8.40 | yes | ok | ok | **X** | **X** | **X** | **X** | **X** |
| 82 | Artarmon | 8.61 | yes | **X** | ok | **X** | **X** | ok | ok | ok |
| 83 | Canterbury | 8.68 | yes | ok | ok | **X** | ok | ok | **X** | **X** |
| 84 | Banksia | 9.10 | yes | ok | ok | **X** | ok | ok | ok | ok |
| 85 | Bardwell Park | 9.18 | yes | ok | ok | **X** | ok | ok | **X** | ok |
| 86 | Burwood | 9.50 | yes | ok | ok | **X** | **X** | **X** | **X** | ok |
| 87 | Rockdale | 9.86 | yes | ok | ok | **X** | **X** | ok | **X** | ok |
| 88 | Chatswood | 9.93 | yes | **X** | **X** | **X** | **X** | ok | **X** | **X** |
| 89 | Campsie | 10.02 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 90 | Bexley North | 10.42 | yes | ok | ok | **X** | ok | ok | **X** | **X** |
| 91 | Strathfield | 10.47 | yes | ok | ok | **X** | **X** | **X** | **X** | ok |
| 92 | Kogarah | 10.99 | yes | ok | **X** | **X** | ok | ok | **X** | ok |
| 93 | Homebush | 11.27 | yes | ok | ok | **X** | **X** | **X** | ok | ok |
| 94 | North Strathfield | 11.30 | yes | ok | **X** | **X** | **X** | ok | **X** | **X** |
| 95 | Roseville | 11.42 | yes | **X** | ok | **X** | ok | ok | **X** | ok |
| 96 | Belmore | 11.48 | yes | ok | ok | **X** | ok | ok | **X** | ok |
| 97 | Kingsgrove | 11.59 | yes | ok | ok | **X** | ok | ok | **X** | ok |
| 98 | North Ryde | 11.83 | yes | ok | ok | **X** | n/a | ok | n/a | ok |
| 99 | Concord West | 11.87 | yes | ok | ok | **X** | **X** | **X** | **X** | ok |
| 100 | Carlton | 11.99 | yes | ok | ok | **X** | ok | ok | ok | ok |
| 101 | Lindfield | 12.55 | yes | ok | ok | **X** | ok | ok | ok | ok |
| 102 | Rhodes | 12.56 | yes | ok | ok | **X** | **X** | **X** | **X** | ok |
| 103 | Lakemba | 12.71 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 104 | Allawah | 12.72 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 105 | Flemington | 12.81 | yes | ok | ok | **X** | **X** | **X** | **X** | **X** |
| 106 | Meadowbank | 13.18 | yes | ok | ok | **X** | **X** | **X** | **X** | **X** |
| 107 | Macquarie Park | 13.18 | yes | **X** | ok | ok | n/a | ok | n/a | ok |
| 108 | Hurstville | 13.31 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 109 | Olympic Park | 13.35 | yes | **X** | **X** | ok | n/a | ok | n/a | ok |
| 110 | Wiley Park | 13.55 | yes | ok | **X** | **X** | ok | ok | **X** | **X** |
| 111 | Beverly Hills | 13.63 | yes | ok | ok | **X** | ok | ok | **X** | **X** |
| 112 | West Ryde | 13.76 | yes | ok | ok | ok | **X** | ok | ok | ok |
| 113 | Killara | 13.83 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 114 | Penshurst | 14.13 | yes | ok | ok | **X** | ok | ok | **X** | **X** |
| 115 | Macquarie University | 14.40 | yes | ok | ok | **X** | n/a | ok | n/a | ok |
| 116 | Narwee | 14.41 | yes | ok | ok | **X** | ok | ok | ok | ok |
| 117 | Denistone | 14.47 | yes | ok | ok | **X** | **X** | ok | **X** | ok |
| 118 | Punchbowl | 14.65 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 119 | Mortdale | 15.03 | yes | ok | ok | **X** | ok | ok | ok | ok |
| 120 | Lidcombe | 15.06 | yes | ok | **X** | **X** | **X** | **X** | **X** | **X** |
| 121 | Gordon | 15.06 | yes | ok | ok | **X** | **X** | ok | **X** | ok |
| 122 | Eastwood | 15.54 | yes | ok | **X** | **X** | **X** | ok | **X** | ok |
| 123 | Oatley | 15.88 | yes | ok | **X** | **X** | ok | ok | ok | ok |
| 124 | Riverwood | 16.09 | yes | ok | ok | **X** | ok | ok | **X** | **X** |
| 125 | Berala | 16.17 | yes | ok | ok | ok | **X** | **X** | ok | ok |
| 126 | Bankstown | 16.27 | yes | ok | ok | **X** | **X** | **X** | **X** | **X** |
| 127 | Auburn | 16.53 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 128 | Pymble | 16.61 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 129 | Regents Park | 16.85 | yes | ok | ok | **X** | ok | **X** | **X** | ok |
| 130 | Birrong | 16.89 | yes | ok | ok | **X** | ok | ok | **X** | ok |
| 131 | Epping | 16.90 | yes | ok | ok | **X** | **X** | **X** | **X** | **X** |
| 132 | Yagoona | 17.02 | yes | ok | ok | **X** | **X** | ok | **X** | ok |
| 133 | Padstow | 17.75 | yes | ok | ok | **X** | ok | ok | **X** | **X** |
| 134 | Sefton | 18.03 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 135 | Telopea | 18.27 | no | n/a | n/a | ok | n/a | ok | n/a | **X** |
| 136 | Clyde | 18.33 | yes | ok | ok | ok | **X** | ok | ok | ok |
| 137 | Dundas | 18.36 | no | n/a | n/a | ok | n/a | ok | n/a | **X** |
| 138 | Turramurra | 18.36 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 139 | Yallamundi | 18.36 | no | n/a | n/a | ok | n/a | ok | n/a | **X** |
| 140 | Rosehill Gardens | 18.37 | no | n/a | n/a | ok | n/a | ok | n/a | **X** |
| 141 | Como | 18.45 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 142 | Cheltenham | 18.55 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 143 | Carlingford | 18.61 | no | n/a | n/a | ok | n/a | ok | n/a | **X** |
| 144 | Granville | 18.83 | yes | ok | ok | **X** | **X** | ok | **X** | ok |
| 145 | Tramway Avenue | 18.92 | no | n/a | n/a | ok | n/a | ok | n/a | **X** |
| 146 | Woolooware | 19.00 | no | n/a | n/a | ok | n/a | ok | n/a | ok |
| 147 | Caringbah | 19.07 | no | n/a | n/a | ok | n/a | ok | n/a | ok |
| 148 | Chester Hill | 19.15 | yes | ok | ok | **X** | ok | ok | **X** | ok |
| 149 | Revesby | 19.25 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 150 | Miranda | 19.38 | no | n/a | n/a | ok | n/a | ok | n/a | ok |
| 151 | Warrawee | 19.43 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 152 | Robin Thomas | 19.56 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 153 | Harris Park | 19.60 | yes | ok | **X** | **X** | **X** | ok | **X** | **X** |
| 154 | Jannali | 19.61 | yes | ok | ok | **X** | **X** | ok | **X** | ok |
| 155 | Cronulla | 19.66 | no | n/a | n/a | ok | n/a | ok | n/a | ok |
| 156 | Beecroft | 19.79 | yes | ok | ok | **X** | ok | ok | **X** | ok |
| 157 | Parramatta | 20.03 | yes | ok | ok | **X** | **X** | ok | **X** | ok |
| 158 | Gymea | 20.08 | no | n/a | n/a | ok | n/a | ok | n/a | ok |
| 159 | Parramatta Square | 20.13 | no | n/a | n/a | **X** | **X** | ok | **X** | **X** |
| 160 | Wahroonga | 20.28 | yes | ok | ok | **X** | **X** | ok | **X** | ok |
| 161 | Church Street | 20.37 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 162 | Prince Alfred Square | 20.41 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 163 | Pennant Hills | 20.44 | yes | ok | ok | **X** | **X** | **X** | **X** | **X** |
| 164 | Leightonfield | 20.46 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 165 | Merrylands | 20.50 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 166 | Fennell Street | 20.54 | no | n/a | n/a | ok | n/a | ok | n/a | **X** |
| 167 | Thornleigh | 20.68 | yes | ok | ok | **X** | ok | **X** | **X** | **X** |
| 168 | Normanhurst | 20.78 | yes | ok | ok | **X** | ok | **X** | **X** | **X** |
| 169 | Panania | 20.79 | yes | ok | ok | **X** | ok | ok | ok | ok |
| 170 | Guildford | 20.80 | yes | ok | ok | **X** | ok | ok | ok | ok |
| 171 | Kirrawee | 20.81 | no | n/a | n/a | ok | n/a | ok | n/a | ok |
| 172 | Benaud Oval | 20.86 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 173 | Ngara | 21.09 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 174 | Villawood | 21.30 | yes | ok | ok | **X** | ok | ok | **X** | ok |
| 175 | Sutherland | 21.37 | yes | ok | ok | **X** | ok | ok | **X** | **X** |
| 176 | Waitara | 21.54 | yes | ok | ok | **X** | **X** | ok | **X** | ok |
| 177 | Childrens Hospital | 21.74 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 178 | Yennora | 21.88 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 179 | Westmead Hospital | 21.89 | no | n/a | n/a | **X** | n/a | ok | n/a | **X** |
| 180 | Westmead | 21.93 | yes | ok | **X** | **X** | **X** | ok | **X** | ok |
| 181 | East Hills | 22.23 | yes | ok | ok | **X** | ok | ok | ok | ok |
| 182 | Hornsby | 22.42 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 183 | Carramar | 22.65 | yes | ok | ok | ok | ok | ok | ok | ok |
| 184 | Loftus | 22.89 | yes | ok | ok | **X** | ok | ok | ok | ok |
| 185 | Cherrybrook | 23.02 | yes | ok | **X** | **X** | ok | ok | ok | ok |
| 186 | Fairfield | 23.11 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 187 | Wentworthville | 23.27 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 188 | Asquith | 23.55 | yes | ok | ok | **X** | **X** | **X** | **X** | ok |
| 189 | Canley Vale | 24.31 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 190 | Holsworthy | 24.71 | yes | ok | ok | **X** | **X** | ok | **X** | ok |
| 191 | Cabramatta | 24.78 | yes | ok | ok | **X** | **X** | **X** | **X** | ok |
| 192 | Pendle Hill | 24.90 | yes | ok | ok | **X** | **X** | ok | **X** | ok |
| 193 | Castle Hill | 25.02 | yes | ok | ok | **X** | n/a | ok | n/a | ok |
| 194 | Mount Colah | 25.06 | yes | ok | ok | **X** | ok | **X** | ok | ok |
| 195 | Warwick Farm | 25.30 | yes | ok | ok | **X** | ok | **X** | **X** | **X** |
| 196 | Toongabbie | 25.93 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 197 | Liverpool | 26.16 | yes | ok | **X** | **X** | **X** | ok | **X** | ok |
| 198 | Mount Kuring-gai | 26.45 | yes | ok | ok | **X** | ok | ok | ok | ok |
| 199 | Hills Showground | 26.70 | yes | ok | **X** | **X** | n/a | ok | n/a | ok |
| 200 | Engadine | 26.97 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 201 | Seven Hills | 27.83 | yes | ok | **X** | **X** | ok | ok | **X** | **X** |
| 202 | Norwest | 27.95 | yes | ok | ok | **X** | n/a | ok | n/a | ok |
| 203 | Casula | 28.20 | yes | ok | ok | **X** | ok | ok | ok | ok |
| 204 | Heathcote | 29.07 | yes | ok | ok | **X** | ok | **X** | ok | ok |
| 205 | Berowra | 29.35 | yes | ok | ok | **X** | ok | ok | **X** | ok |
| 206 | Bella Vista | 29.69 | yes | ok | ok | **X** | ok | ok | **X** | **X** |
| 207 | Blacktown | 30.51 | yes | ok | **X** | **X** | **X** | ok | **X** | ok |
| 208 | Glenfield | 30.56 | yes | ok | ok | ok | **X** | **X** | ok | ok |
| 209 | Kellyville | 31.50 | yes | ok | ok | **X** | ok | ok | ok | ok |
| 210 | Marayong | 32.23 | yes | ok | ok | **X** | ok | ok | ok | ok |
| 211 | Macquarie Fields | 32.26 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 212 | Cowan | 32.47 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 213 | Edmondson Park | 33.51 | yes | **X** | ok | **X** | ok | ok | **X** | ok |
| 214 | Rouse Hill | 33.76 | yes | ok | ok | **X** | ok | ok | ok | ok |
| 215 | Waterfall | 33.95 | yes | ok | ok | **X** | ok | ok | **X** | **X** |
| 216 | Ingleburn | 33.96 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 217 | Doonside | 34.03 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 218 | Quakers Hill | 34.35 | yes | ok | ok | **X** | **X** | ok | **X** | ok |
| 219 | Tallawong | 35.11 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 220 | Rooty Hill | 35.72 | yes | ok | ok | **X** | **X** | ok | **X** | ok |
| 221 | Schofields | 36.72 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 222 | Minto | 37.17 | yes | ok | ok | **X** | **X** | ok | **X** | ok |
| 223 | Hawkesbury River | 37.46 | yes | ok | ok | **X** | ok | ok | **X** | ok |
| 224 | Leppington | 37.65 | yes | ok | ok | **X** | ok | ok | **X** | **X** |
| 225 | Helensburgh | 37.87 | no | n/a | n/a | ok | n/a | ok | n/a | ok |
| 226 | Mount Druitt | 37.95 | yes | ok | ok | **X** | ok | ok | **X** | ok |
| 227 | Riverstone | 39.32 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 228 | Leumeah | 39.34 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 229 | Otford | 40.65 | no | n/a | n/a | **X** | n/a | ok | n/a | ok |
| 230 | Campbelltown | 41.32 | yes | ok | ok | **X** | **X** | **X** | **X** | ok |
| 231 | Vineyard | 41.91 | yes | ok | ok | **X** | ok | ok | ok | ok |
| 232 | St Marys | 42.17 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 233 | Macarthur | 43.15 | yes | ok | **X** | **X** | ok | ok | **X** | ok |
| 234 | Stanwell Park | 43.26 | no | n/a | n/a | **X** | n/a | ok | n/a | ok |
| 235 | Werrington | 43.78 | yes | ok | ok | **X** | **X** | ok | **X** | ok |
| 236 | Coalcliff | 44.96 | no | n/a | n/a | **X** | n/a | ok | n/a | ok |
| 237 | Mulgrave | 45.06 | yes | ok | ok | ok | ok | ok | ok | ok |
| 238 | Woy Woy | 45.51 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 239 | Kingswood | 47.16 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 240 | Windsor | 47.37 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 241 | Koolewong | 47.52 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 242 | Scarborough | 47.69 | no | n/a | n/a | **X** | n/a | ok | n/a | ok |
| 243 | Menangle Park | 49.08 | no | n/a | n/a | ok | n/a | ok | n/a | ok |
| 244 | Tascott | 49.20 | yes | ok | ok | **X** | ok | ok | **X** | **X** |
| 245 | Wombarra | 49.29 | no | n/a | n/a | **X** | n/a | ok | n/a | ok |
| 246 | Clarendon | 49.39 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 247 | Penrith | 49.55 | yes | ok | ok | ok | **X** | ok | **X** | ok |
| 248 | Point Clare | 49.91 | yes | ok | ok | **X** | **X** | ok | **X** | ok |
| 249 | Menangle | 50.35 | no | n/a | n/a | ok | n/a | ok | n/a | ok |
| 250 | Coledale | 51.08 | no | n/a | n/a | ok | n/a | ok | n/a | ok |
| 251 | Emu Plains | 51.87 | yes | ok | ok | **X** | ok | ok | ok | ok |
| 252 | East Richmond | 51.97 | yes | ok | ok | **X** | **X** | **X** | ok | ok |
| 253 | Richmond | 52.64 | yes | ok | ok | ok | **X** | ok | ok | ok |
| 254 | Gosford | 52.65 | yes | ok | ok | **X** | **X** | ok | **X** | **X** |
| 255 | Austinmer | 53.35 | no | n/a | n/a | ok | n/a | ok | n/a | ok |
| 256 | Lapstone | 53.61 | no | n/a | n/a | **X** | n/a | ok | n/a | ok |
| 257 | Thirroul | 54.94 | no | n/a | n/a | ok | n/a | ok | n/a | ok |
| 258 | Glenbrook | 55.71 | no | n/a | n/a | ok | n/a | ok | n/a | ok |
| 259 | Narara | 55.80 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 260 | Douglas Park | 56.55 | no | n/a | n/a | ok | n/a | ok | n/a | ok |
| 261 | Bulli | 56.71 | no | n/a | n/a | ok | n/a | ok | n/a | ok |
| 262 | Niagara Park | 57.27 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 263 | Blaxland | 57.42 | no | n/a | n/a | **X** | n/a | ok | n/a | ok |
| 264 | Lisarow | 57.73 | yes | ok | ok | **X** | **X** | ok | ok | ok |
| 265 | Woonona | 58.17 | no | n/a | n/a | ok | n/a | ok | n/a | ok |
| 266 | Warrimoo | 58.79 | no | n/a | n/a | ok | n/a | ok | n/a | ok |
| 267 | Ourimbah | 60.15 | yes | ok | ok | **X** | ok | ok | **X** | **X** |

## The stations already known broken

Named in the round brief, reproduced here so the suite can be seen catching them
rather than taken on trust. A row of `ok` against a station a player has fallen
through would be the suite failing, not the world passing.

| station | reach | stand | holes | clear | ttt | tworld | vert |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Central | **X** | **X** | **X** | **X** | **X** | **X** | ok |
| Redfern | ok | **X** | **X** | ok | **X** | **X** | **X** |
| Erskineville | ok | ok | **X** | **X** | **X** | **X** | **X** |
| Newtown | ok | **X** | **X** | **X** | **X** | **X** | **X** |
| St Peters | ok | **X** | **X** | **X** | ok | **X** | ok |
| Sydenham | ok | ok | **X** | **X** | ok | **X** | **X** |
| Chatswood | **X** | **X** | **X** | **X** | ok | **X** | **X** |
| Roseville | **X** | ok | **X** | ok | ok | **X** | ok |
| Lindfield | ok | ok | **X** | ok | ok | ok | ok |

## Summary

| check | pass | fail | n/a |
|---|---:|---:|---:|
| reach | 170 | 20 | 77 |
| stand | 159 | 31 | 77 |
| holes | 47 | 220 | 0 |
| clear | 61 | 111 | 95 |
| ttt | 217 | 50 | 0 |
| tworld | 56 | 118 | 93 |
| vert | 148 | 119 | 0 |

**2 of 190 served stations pass all seven.**

19 of 267 pass counting the 77 stations the timetable never reaches -- but those have no platform to walk onto and no train to hit anything, so five of their seven columns are `n/a` and they pass by not being asked. The served number is the one to work from.

## Trains through trains

30,583 overlapping carriage pairs over 720 instants (1,576,244 poses, 582,455 narrow-phase pairs), worst 21.4 m of interpenetration.

| mechanism | overlapping pairs |
|---|---:|
| opposite-slot | 23,269 |
| same-line-both-ways | 1,698 |
| cross-line | 4,567 |
| same-service | 1,049 |
| same-rail | 0 |

And the root cause behind `opposite-slot`: `rail.railKey` calls two trains running
opposite ways through a block *different rails*, which is right about a double-track
railway drawn as two tracks. Measured, the bake draws a great deal of it as one:

| line | samples | within 0.5 m of the other direction | mean apart |
|---|---:|---:|---:|
| T6 | 38 | 50% | 5.4 m |
| T5 | 185 | 24% | 9.3 m |
| CCN | 325 | 22% | 7.2 m |
| T9 | 119 | 16% | 12.7 m |
| T7 | 19 | 16% | 26.2 m |
| T2 | 200 | 16% | 10.9 m |
| T3 | 130 | 14% | 12.9 m |
| T1 | 331 | 9% | 13.0 m |
| T8 | 202 | 2% | 11.0 m |
| M1 | 266 | 1% | 16.6 m |
| T4 | 180 | 0% | 11.7 m |

| direction pair | overlaps | worst | at |
|---|---:|---:|---|
| CCN:0 x T9:1 | 4604 | 19.8 m | -12397, -14987 |
| CCN:0 x CCN:1 | 3564 | 19.9 m | -11151, -6067 |
| T2:0 x T8:1 | 2533 | 19.8 m | 254, 197 |
| T2:0 x T2:1 | 2225 | 19.8 m | -237, 1767 |
| T2:1 x T8:0 | 1745 | 19.9 m | -234, 1769 |
| CCN:1 x T9:0 | 1612 | 19.7 m | -11132, -5697 |
| T1:0 x T3:1 | 1426 | 19.8 m | -928, 2542 |
| CCN:1 x T3:0 | 840 | 19.2 m | -9977, 1050 |
| T2:0 x T5:0 | 769 | 19.8 m | -24953, 3304 |
| T5:1 x T8:1 | 766 | 19.8 m | -28979, 11965 |
| T3:0 x T3:1 | 744 | 19.7 m | -17023, 1692 |
| T3:1 x T5:1 | 692 | 19.7 m | -25256, 5344 |
| T5:0 x T5:1 | 646 | 19.8 m | -42238, -28789 |
| T8:0 x T8:1 | 566 | 19.5 m | -35858, 22109 |
| T1:1 x T8:0 | 561 | 19.7 m | -244, 1783 |
| T4:1 x T4:1 | 549 | 19.7 m | -2089, 3382 |
| M1:0 x M1:1 | 525 | 21.4 m | -15949, 5718 |
| T2:1 x T9:0 | 468 | 19.6 m | -2485, 3261 |
| T3:0 x T5:0 | 449 | 19.6 m | -25256, 5344 |
| T1:0 x T2:0 | 443 | 19.8 m | -233, 619 |
| T3:1 x T9:0 | 436 | 19.8 m | -232, 1702 |
| T4:0 x T4:0 | 372 | 19.7 m | -887, 2581 |
| T6:0 x T6:1 | 352 | 17.0 m | -16668, 5200 |
| T4:0 x T4:1 | 351 | 18.8 m | -18226, 24768 |
| T9:0 x T9:1 | 296 | 18.9 m | -11387, -16073 |
| T2:0 x T8:0 | 233 | 19.8 m | -237, 1767 |
| T3:1 x T9:1 | 224 | 19.3 m | -5962, 2692 |
| T1:0 x T1:1 | 221 | 19.7 m | -8672, -22131 |
| T2:1 x T3:0 | 179 | 19.7 m | -4890, 2858 |
| T4:0 x T8:0 | 179 | 19.2 m | -229, 715 |

## Notes, per failing station

### Central (0.00 km)
- **reach**: 7/8 decks reachable on foot; sealed at -255,1719
- **stand**: 6/8 decks walkable end to end; 1 lifted onto a solid (0.5 m up on a solid); 1 left the deck (-0.54 m off)
- **holes**: 6/2511 drawn-ground samples unsupported (worst 1.0 m at -178,1722); 5/314 bodies dropped through the surface they were standing on (worst 2.5 m); 5 invisible sheets over a carved corridor; 5 of 14 bodies walked off the rim into the corridor; client/server ground splits at 568 samples (worst 5.8 m)
- **clear**: 162 rail assets stand in drawn paving (fence at -273,1771); 622 explained by the railway being over the road
- **ttt**: 2602 carriage overlaps within 200 m, worst 19.9 m deep; commonest same-line-both-ways T2:0 x T2:1 (605)
- **tworld**: 61 carriage poses inside a building prism and 41 under drawn terrain, of 1963 sampled within 300 m (T2:1 car 0 at -258,1802 under drawn terrain)

### Central Chalmers Street (0.12 km)
- **holes**: 3/2511 drawn-ground samples unsupported (worst 1.0 m at -170,1706); 1/314 bodies dropped through the surface they were standing on (worst 1.5 m); 4 of 14 bodies walked off the rim into the corridor; client/server ground splits at 245 samples (worst 5.6 m)
- **clear**: 92 rail assets stand in drawn paving (fence at -273,1771); 583 explained by the railway being over the road
- **ttt**: 2602 carriage overlaps within 200 m, worst 19.9 m deep; commonest same-line-both-ways T2:0 x T2:1 (605)
- **tworld**: 61 carriage poses inside a building prism and 37 under drawn terrain, of 1717 sampled within 300 m (T2:1 car 0 at -258,1802 under drawn terrain)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Central Grand Concourse (0.23 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 7 samples (worst 5.4 m)
- **clear**: 77 rail assets stand in drawn paving (fence at -273,1771); 684 explained by the railway being over the road
- **ttt**: 2566 carriage overlaps within 200 m, worst 19.9 m deep; commonest same-line-both-ways T2:0 x T2:1 (605)
- **tworld**: 61 carriage poses inside a building prism and 17 under drawn terrain, of 1115 sampled within 300 m (T2:1 car 0 at -258,1802 under drawn terrain)

### Haymarket (0.35 km)
- **holes**: 2 of 14 bodies walked off the rim into the corridor
- **ttt**: 156 carriage overlaps within 200 m, worst 19.8 m deep; commonest same-line-both-ways T2:0 x T2:1 (101)
- **tworld**: 4 carriage poses inside a building prism and 6 under drawn terrain, of 262 sampled within 300 m (T9:0 car 0 at -214,1678 through a prism)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Capitol Square (0.52 km)
- **holes**: 1/314 bodies dropped through the surface they were standing on (worst 1.3 m); 1 of 14 bodies walked off the rim into the corridor
- **clear**: 2 rail assets stand in drawn paving (fence at -53,1254); 92 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 21 under drawn terrain, of 131 sampled within 300 m (T8:1 car 0 at -27,1254 under drawn terrain)

### Surry Hills (0.65 km)
- **holes**: 2 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Chinatown (0.65 km)
- **holes**: 1/314 bodies dropped through the surface they were standing on (worst 1.0 m); 1 of 14 bodies walked off the rim into the corridor
- **ttt**: 78 carriage overlaps within 200 m, worst 19.6 m deep; commonest cross-line T4:0 x T8:0 (22)

### Paddy's Markets (0.66 km)
- **holes**: 2 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Museum (1.01 km)
- **reach**: 0/1 decks reachable on foot; sealed at 82,784
- **holes**: 37/2511 drawn-ground samples unsupported (worst 13.8 m at 116,723); 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 3 samples (worst 0.2 m)
- **ttt**: 1434 carriage overlaps within 200 m, worst 19.8 m deep; commonest cross-line T1:0 x T2:0 (352)

### Exhibition Centre (1.01 km)
- **holes**: 6/314 bodies dropped through the surface they were standing on (worst 2.1 m); 1 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Redfern (1.13 km)
- **stand**: 2/5 decks walkable end to end; 2 lifted onto a solid (6.8 m up on a solid); 1 left the deck (0.69 m off)
- **holes**: 15/314 bodies dropped through the surface they were standing on (worst 4.0 m); 7 invisible sheets over a carved corridor; client/server ground splits at 879 samples (worst 9.7 m)
- **ttt**: 1543 carriage overlaps within 200 m, worst 19.8 m deep; commonest opposite-slot T1:0 x T3:1 (755)
- **tworld**: 0 carriage poses inside a building prism and 371 under drawn terrain, of 1951 sampled within 300 m (T9:1 car 7 at -935,2558 under drawn terrain)
- **vert**: 3/251 drawn track vertices sit more than a metre under uncarved terrain

### Town Hall (1.19 km)
- **holes**: 452/2511 drawn-ground samples unsupported (worst 17.6 m at -224,488); 5/314 bodies dropped through the surface they were standing on (worst 18.5 m); 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 163 samples (worst 2.0 m)
- **ttt**: 1559 carriage overlaps within 200 m, worst 19.8 m deep; commonest opposite-slot T1:1 x T8:0 (474)
- **vert**: the bake's clearance is -20.67 m and the shipped DEM measures -17.12 m at the site

### Gadigal (1.19 km)
- **reach**: 0/2 decks reachable on foot; sealed at -6,565 -106,559
- **holes**: 397/2511 drawn-ground samples unsupported (worst 18.3 m at -71,558); 2/314 bodies dropped through the surface they were standing on (worst 16.8 m); 4 of 14 bodies walked off the rim into the corridor
- **ttt**: 1631 carriage overlaps within 200 m, worst 19.8 m deep; commonest opposite-slot T1:1 x T8:0 (474)

### QVB (1.43 km)
- **holes**: 7/314 bodies dropped through the surface they were standing on (worst 1.7 m)
- **ttt**: 1412 carriage overlaps within 200 m, worst 19.8 m deep; commonest opposite-slot T1:1 x T8:0 (474)

### Convention (1.53 km)
- **holes**: 20/314 bodies dropped through the surface they were standing on (worst 2.1 m)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Waterloo (1.57 km)
- **reach**: 0/2 decks reachable on foot; sealed at -767,3218 -780,3222

### St James (1.59 km)
- **reach**: 0/2 decks reachable on foot; sealed at 251,227 222,224
- **holes**: 78/2511 drawn-ground samples unsupported (worst 13.3 m at 238,298)
- **ttt**: 1495 carriage overlaps within 200 m, worst 19.8 m deep; commonest opposite-slot T2:0 x T8:1 (745)

### Wentworth Park (1.60 km)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Moore Park (1.75 km)
- **holes**: 2 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Kings Cross (1.83 km)
- **reach**: 1/2 decks reachable on foot; sealed at 1211,602
- **stand**: 1/2 decks walkable end to end; 1 left the deck (-2.46 m off)
- **holes**: 252/2511 drawn-ground samples unsupported (worst 19.6 m at 1220,611); 3/314 bodies dropped through the surface they were standing on (worst 19.6 m); 4 of 14 bodies walked off the rim into the corridor; client/server ground splits at 76 samples (worst 2.5 m)
- **clear**: 1 rail assets stand in drawn paving (fence at 1056,521); 33 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 15 under drawn terrain, of 60 sampled within 300 m (T4:0 car 0 at 1006,487 under drawn terrain)
- **vert**: 2/12 drawn track vertices sit more than a metre under uncarved terrain

### Pyrmont Bay (1.86 km)
- **holes**: 7/314 bodies dropped through the surface they were standing on (worst 2.9 m)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Martin Place (1.90 km)
- **reach**: 0/4 decks reachable on foot; sealed at 112,-120 115,-100 115,-140 48,-146
- **stand**: 2/4 decks walkable end to end; 2 left the deck (33.57 m off)
- **holes**: 76/2511 drawn-ground samples unsupported (worst 25.3 m at 156,-187); 1 of 14 bodies walked off the rim into the corridor
- **ttt**: 91 carriage overlaps within 200 m, worst 19.1 m deep; commonest cross-line T1:0 x T8:1 (72)
- **vert**: the bake's clearance is -33.31 m and the shipped DEM measures -27.72 m at the site

### Glebe (1.93 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Bank Street (1.98 km)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Wynyard (2.00 km)
- **stand**: 2/3 decks walkable end to end; 1 left the deck (1.34 m off)
- **holes**: 552/2511 drawn-ground samples unsupported (worst 13.5 m at -318,-360); 10/314 bodies dropped through the surface they were standing on (worst 1.3 m); 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 222 samples (worst 1.8 m)
- **ttt**: 448 carriage overlaps within 200 m, worst 19.7 m deep; commonest opposite-slot T2:0 x T8:1 (198)
- **vert**: the bake's clearance is -17.27 m and the shipped DEM measures -12.17 m at the site

### The Star (2.13 km)
- **holes**: 31/314 bodies dropped through the surface they were standing on (worst 6.2 m); 3 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Bridge Street (2.26 km)
- **holes**: 2/314 bodies dropped through the surface they were standing on (worst 1.4 m)
- **ttt**: 1064 carriage overlaps within 200 m, worst 19.8 m deep; commonest opposite-slot T2:1 x T8:0 (498)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### John Street Square (2.31 km)
- **holes**: 2 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Macdonaldtown (2.34 km)
- **stand**: 2/3 decks walkable end to end; 1 lifted onto a solid (7.0 m up on a solid)
- **holes**: 2/314 bodies dropped through the surface they were standing on (worst 8.8 m); 4 of 14 bodies walked off the rim into the corridor; client/server ground splits at 308 samples (worst 8.7 m)
- **ttt**: 641 carriage overlaps within 200 m, worst 19.7 m deep; commonest same-service T4:1 x T4:1 (261)
- **tworld**: 0 carriage poses inside a building prism and 8 under drawn terrain, of 1101 sampled within 300 m (T4:1 car 0 at -2076,3409 under drawn terrain)

### Green Square (2.44 km)
- **reach**: 0/1 decks reachable on foot; sealed at -560,4160
- **stand**: 0/1 decks walkable end to end; 1 left the deck (-0.02 m off)
- **holes**: 1/314 bodies dropped through the surface they were standing on (worst 1.1 m); 1 of 14 bodies walked off the rim into the corridor
- **ttt**: 16 carriage overlaps within 200 m, worst 19.1 m deep; commonest same-line-both-ways T8:0 x T8:1 (16)

### Circular Quay (2.59 km)
- **stand**: 0/1 decks walkable end to end; 1 left the deck (-2.80 m off)
- **holes**: 5/314 bodies dropped through the surface they were standing on (worst 5.6 m); 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 23 samples (worst 8.0 m)
- **clear**: 12/48 gauge probes hit a building prism (49,-838 at -39.9 m); 13 rail assets stand in drawn paving (fence at 32,-829)
- **ttt**: 1509 carriage overlaps within 200 m, worst 19.8 m deep; commonest opposite-slot T2:1 x T8:0 (751)
- **tworld**: 295 carriage poses inside a building prism and 221 under drawn terrain, of 436 sampled within 300 m (T8:1 car 0 at 162,-827 through a prism)
- **vert**: 34/48 drawn track vertices sit more than a metre under uncarved terrain

### Erskineville (2.67 km)
- **holes**: 1/314 bodies dropped through the surface they were standing on (worst 1.5 m); 4 of 14 bodies walked off the rim into the corridor; client/server ground splits at 150 samples (worst 6.5 m)
- **clear**: 19 rail assets stand in drawn paving (fence at -2150,3664); 31 explained by the railway being over the road
- **ttt**: 336 carriage overlaps within 200 m, worst 19.7 m deep; commonest same-service T4:1 x T4:1 (261)
- **tworld**: 0 carriage poses inside a building prism and 51 under drawn terrain, of 570 sampled within 300 m (T4:1 car 0 at -2076,3409 under drawn terrain)
- **vert**: the bake's clearance is -4.83 m and the shipped DEM measures -1.73 m at the site; 2/53 drawn track vertices sit more than a metre under uncarved terrain

### Jubilee Park (2.75 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Barangaroo (2.78 km)
- **reach**: 0/2 decks reachable on foot; sealed at -628,-1008 -641,-1007
- **holes**: 2 of 14 bodies walked off the rim into the corridor
- **vert**: the bake's clearance is -9.47 m and the shipped DEM measures -14.49 m at the site

### Edgecliff (2.81 km)
- **reach**: 0/2 decks reachable on foot; sealed at 2503,1110 2501,1123
- **stand**: 0/2 decks walkable end to end; 2 left the deck (0.14 m off)
- **holes**: 168/2511 drawn-ground samples unsupported (worst 7.8 m at 2438,1101); 10/314 bodies dropped through the surface they were standing on (worst 12.1 m); 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 33 samples (worst 0.1 m)
- **clear**: 7 rail assets stand in drawn paving (fence at 2313,1033); 46 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 9 under drawn terrain, of 42 sampled within 300 m (T4:0 car 0 at 2318,1044 under drawn terrain)
- **vert**: 1/11 drawn track vertices sit more than a metre under uncarved terrain

### ES Marks (2.86 km)
- **holes**: 3 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Newtown (2.88 km)
- **stand**: 2/3 decks walkable end to end; 2 left the deck (-0.47 m off)
- **holes**: 3/314 bodies dropped through the surface they were standing on (worst 9.6 m); 9 invisible sheets over a carved corridor; 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 674 samples (worst 11.7 m)
- **clear**: 20 rail assets stand in drawn paving (fence at -2978,3235)
- **ttt**: 279 carriage overlaps within 200 m, worst 19.6 m deep; commonest cross-line T3:1 x T9:1 (122)
- **tworld**: 0 carriage poses inside a building prism and 86 under drawn terrain, of 651 sampled within 300 m (T3:0 car 4 at -2509,3259 under drawn terrain)
- **vert**: 6/128 drawn track vertices sit more than a metre under uncarved terrain

### Royal Randwick (3.10 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Kensington (3.18 km)
- **holes**: 4 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Rozelle Bay (3.41 km)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### St Peters (3.48 km)
- **stand**: 0/2 decks walkable end to end; 2 left the deck (-0.58 m off)
- **holes**: 6/2511 drawn-ground samples unsupported (worst 0.9 m at -2623,4371); 2/314 bodies dropped through the surface they were standing on (worst 1.7 m); 7 invisible sheets over a carved corridor; 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 225 samples (worst 9.4 m)
- **clear**: 3 rail assets stand in drawn paving (fence at -2811,4409)
- **tworld**: 0 carriage poses inside a building prism and 108 under drawn terrain, of 504 sampled within 300 m (T4:0 car 1 at -2546,4323 under drawn terrain)

### Wansey Road (3.93 km)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Bondi Junction (3.95 km)
- **reach**: 1/2 decks reachable on foot; sealed at 3682,2442
- **stand**: 0/2 decks walkable end to end; 3 left the deck (9.07 m off)
- **holes**: 384/2511 drawn-ground samples unsupported (worst 10.4 m at 3659,2429); 5/314 bodies dropped through the surface they were standing on (worst 1.6 m); 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 7 samples (worst 1.6 m)

### Lilyfield (3.99 km)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### UNSW Anzac Parade (4.00 km)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Stanmore (4.09 km)
- **holes**: 6/2511 drawn-ground samples unsupported (worst 0.8 m at -4069,2924); 6 invisible sheets over a carved corridor; client/server ground splits at 360 samples (worst 6.8 m)
- **clear**: 210 rail assets stand in drawn paving (fence at -4455,2924); 8 explained by the railway being over the road
- **ttt**: 217 carriage overlaps within 200 m, worst 19.0 m deep; commonest opposite-slot T2:1 x T9:0 (87)
- **tworld**: 0 carriage poses inside a building prism and 17 under drawn terrain, of 687 sampled within 300 m (T2:1 car 5 at -4124,2929 under drawn terrain)
- **vert**: 3/124 drawn track vertices sit more than a metre under uncarved terrain

### Milsons Point (4.31 km)
- **stand**: 1/2 decks walkable end to end; 1 lifted onto a solid (0.6 m up on a solid); 1 left the deck (-0.34 m off)
- **holes**: 2/314 bodies dropped through the surface they were standing on (worst 2.1 m); 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 36 samples (worst 4.5 m)
- **clear**: 12/49 gauge probes hit a building prism (214,-2464 at -29.4 m); 11 rail assets stand in drawn paving (fence at 101,-2765); 405 explained by the railway being over the road
- **tworld**: 86 carriage poses inside a building prism and 5 under drawn terrain, of 167 sampled within 300 m (T1:1 car 0 at 92,-2804 under drawn terrain)
- **vert**: the bake's clearance is -0.82 m and the shipped DEM measures 3.29 m at the site

### UNSW High Street (4.45 km)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Kingsford (4.55 km)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Mascot (4.65 km)
- **reach**: 0/1 decks reachable on foot; sealed at -1930,6068

### North Sydney (4.80 km)
- **stand**: 1/2 decks walkable end to end; 1 left the deck (0.03 m off)
- **holes**: 378/2511 drawn-ground samples unsupported (worst 16.7 m at -319,-3085); 1/314 bodies dropped through the surface they were standing on (worst 1.3 m); client/server ground splits at 81 samples (worst 0.0 m)
- **tworld**: 0 carriage poses inside a building prism and 9 under drawn terrain, of 21 sampled within 300 m (T1:1 car 1 at -75,-3012 under drawn terrain)
- **vert**: the bake's clearance is -24.03 m and the shipped DEM measures -13.57 m at the site

### Randwick (4.81 km)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Petersham (4.84 km)
- **holes**: 1/2511 drawn-ground samples unsupported (worst 0.6 m at -4867,2833); 2/314 bodies dropped through the surface they were standing on (worst 1.9 m); 1 invisible sheets over a carved corridor; client/server ground splits at 364 samples (worst 5.0 m)
- **clear**: 31 rail assets stand in drawn paving (fence at -5089,2876); 45 explained by the railway being over the road
- **ttt**: 127 carriage overlaps within 200 m, worst 19.7 m deep; commonest cross-line T2:1 x T3:0 (120)
- **tworld**: 0 carriage poses inside a building prism and 48 under drawn terrain, of 688 sampled within 300 m (T9:0 car 5 at -4742,2860 under drawn terrain)
- **vert**: 2/145 drawn track vertices sit more than a metre under uncarved terrain

### Leichhardt North (4.95 km)
- **holes**: 2 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Juniors Kingsford (4.97 km)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Sydenham (5.02 km)
- **holes**: 8/314 bodies dropped through the surface they were standing on (worst 3.9 m); 4 invisible sheets over a carved corridor; 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 451 samples (worst 9.8 m)
- **clear**: 40 rail assets stand in drawn paving (fence at -3808,5121)
- **tworld**: 0 carriage poses inside a building prism and 201 under drawn terrain, of 879 sampled within 300 m (M1:0 car 0 at -3939,5176 under drawn terrain)
- **vert**: 8/126 drawn track vertices sit more than a metre under uncarved terrain

### Waverton (5.20 km)
- **holes**: 4/2511 drawn-ground samples unsupported (worst 1.5 m at -1174,-3432); 1/314 bodies dropped through the surface they were standing on (worst 1.5 m); 2 invisible sheets over a carved corridor; 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 197 samples (worst 8.4 m)
- **clear**: 2 rail assets stand in drawn paving (fence at -1080,-3321); 89 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 28 under drawn terrain, of 150 sampled within 300 m (T1:0 car 0 at -1168,-3448 under drawn terrain)
- **vert**: 4/60 drawn track vertices sit more than a metre under uncarved terrain

### Victoria Cross (5.36 km)
- **holes**: 749/2511 drawn-ground samples unsupported (worst 32.7 m at -231,-3726); client/server ground splits at 203 samples (worst 0.0 m)
- **vert**: the bake's clearance is -39.03 m and the shipped DEM measures -31.99 m at the site

### Hawthorne (5.50 km)
- **holes**: 2 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Lewisham (5.52 km)
- **holes**: 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 506 samples (worst 4.3 m)
- **clear**: 17 rail assets stand in drawn paving (fence at -5561,2868); 256 explained by the railway being over the road
- **ttt**: 327 carriage overlaps within 200 m, worst 19.3 m deep; commonest cross-line CCN:1 x T3:0 (108)
- **tworld**: 0 carriage poses inside a building prism and 26 under drawn terrain, of 672 sampled within 300 m (T3:0 car 2 at -5438,2879 under drawn terrain)
- **vert**: 4/125 drawn track vertices sit more than a metre under uncarved terrain

### Marion (5.67 km)
- **holes**: 2 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Taverners Hill (5.68 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor
- **ttt**: 36 carriage overlaps within 200 m, worst 19.3 m deep; commonest cross-line T3:1 x T9:1 (36)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Marrickville (5.88 km)
- **holes**: 2 invisible sheets over a carved corridor; 7 of 14 bodies walked off the rim into the corridor; client/server ground splits at 219 samples (worst 10.8 m)
- **tworld**: 0 carriage poses inside a building prism and 78 under drawn terrain, of 375 sampled within 300 m (M1:0 car 1 at -5127,5070 under drawn terrain)
- **vert**: 1/45 drawn track vertices sit more than a metre under uncarved terrain

### Lewisham West (5.92 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor
- **ttt**: 210 carriage overlaps within 200 m, worst 19.3 m deep; commonest opposite-slot T2:1 x T9:0 (80)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Domestic Airport (5.95 km)
- **reach**: 0/1 decks reachable on foot; sealed at -2503,7241

### Wollstonecraft (6.00 km)
- **holes**: 13/2511 drawn-ground samples unsupported (worst 1.4 m at -1697,-4009); 1/314 bodies dropped through the surface they were standing on (worst 5.9 m); 3 invisible sheets over a carved corridor; 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 235 samples (worst 7.5 m)
- **clear**: 3 rail assets stand in drawn paving (fence at -1712,-4095); 77 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 14 under drawn terrain, of 174 sampled within 300 m (T1:1 car 1 at -1693,-4059 under drawn terrain)
- **vert**: 1/59 drawn track vertices sit more than a metre under uncarved terrain

### Summer Hill (6.29 km)
- **stand**: 1/2 decks walkable end to end; 1 lifted onto a solid (7.2 m up on a solid)
- **holes**: 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 445 samples (worst 5.4 m)
- **clear**: 85 rail assets stand in drawn paving (fence at -6545,2457); 605 explained by the railway being over the road
- **ttt**: 22 carriage overlaps within 200 m, worst 19.5 m deep; commonest cross-line CCN:0 x T3:1 (22)

### Waratah Mills (6.33 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Tempe (6.41 km)
- **holes**: 28/2511 drawn-ground samples unsupported (worst 1.4 m at -4780,6348); 1 invisible sheets over a carved corridor; 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 347 samples (worst 4.1 m)
- **clear**: 26 rail assets stand in drawn paving (fence at -4803,6378); 15 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 30 under drawn terrain, of 504 sampled within 300 m (T4:1 car 2 at -4738,6008 under drawn terrain)

### Crows Nest (6.54 km)
- **holes**: 136/2511 drawn-ground samples unsupported (worst 13.0 m at -1055,-4789); client/server ground splits at 7 samples (worst 0.0 m)

### Arlington (6.61 km)
- **holes**: 4 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Dulwich Grove (6.64 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### International Airport (6.74 km)
- **reach**: 0/1 decks reachable on foot; sealed at -3887,7412
- **holes**: 87/2511 drawn-ground samples unsupported (worst 13.3 m at -3954,7368); 2/314 bodies dropped through the surface they were standing on (worst 13.4 m); 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 1 samples (worst 0.1 m)

### Dulwich Hill (6.77 km)
- **holes**: 1/2511 drawn-ground samples unsupported (worst 0.7 m at -6261,4791); 1/314 bodies dropped through the surface they were standing on (worst 1.4 m); 6 invisible sheets over a carved corridor; 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 347 samples (worst 7.4 m)
- **clear**: 5 rail assets stand in drawn paving (fence at -6286,4796); 25 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 33 under drawn terrain, of 372 sampled within 300 m (M1:1 car 3 at -6208,4808 under drawn terrain)
- **vert**: 3/66 drawn track vertices sit more than a metre under uncarved terrain

### Wolli Creek (6.89 km)
- **holes**: 1/2511 drawn-ground samples unsupported (worst 0.7 m at -5035,6678); 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 288 samples (worst 9.5 m)
- **clear**: 5 rail assets stand in drawn paving (fence at -4954,6611); 175 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 96 under drawn terrain, of 696 sampled within 300 m (T8:0 car 0 at -4933,6724 under drawn terrain)
- **vert**: 3/66 drawn track vertices sit more than a metre under uncarved terrain

### St Leonards (6.97 km)
- **holes**: 469/2511 drawn-ground samples unsupported (worst 9.7 m at -1472,-5086); 2/314 bodies dropped through the surface they were standing on (worst 9.7 m); 4 of 14 bodies walked off the rim into the corridor; client/server ground splits at 31 samples (worst 5.8 m)
- **tworld**: 0 carriage poses inside a building prism and 13 under drawn terrain, of 63 sampled within 300 m (T1:0 car 0 at -1516,-5264 under drawn terrain)
- **vert**: the bake's clearance is -12.61 m and the shipped DEM measures -8.85 m at the site

### Ashfield (7.46 km)
- **holes**: 3/2511 drawn-ground samples unsupported (worst 1.2 m at -7605,2239); 2/314 bodies dropped through the surface they were standing on (worst 4.6 m); client/server ground splits at 307 samples (worst 6.8 m)
- **clear**: 74 rail assets stand in drawn paving (fence at -7703,2188); 189 explained by the railway being over the road
- **ttt**: 289 carriage overlaps within 200 m, worst 19.8 m deep; commonest opposite-slot T1:0 x T3:1 (106)
- **tworld**: 0 carriage poses inside a building prism and 13 under drawn terrain, of 675 sampled within 300 m (T3:0 car 6 at -7694,2220 under drawn terrain)

### Hurlstone Park (7.49 km)
- **holes**: 23/2511 drawn-ground samples unsupported (worst 1.5 m at -7100,4779); 1/314 bodies dropped through the surface they were standing on (worst 1.6 m); 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 179 samples (worst 9.4 m)
- **clear**: 20 rail assets stand in drawn paving (fence at -7101,4782); 44 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 42 under drawn terrain, of 375 sampled within 300 m (M1:0 car 0 at -7033,4724 under drawn terrain)
- **vert**: 1/57 drawn track vertices sit more than a metre under uncarved terrain

### Arncliffe (7.94 km)
- **holes**: 3/2511 drawn-ground samples unsupported (worst 1.2 m at -5594,7674); 5/314 bodies dropped through the surface they were standing on (worst 1.6 m); client/server ground splits at 349 samples (worst 4.8 m)
- **clear**: 7 rail assets stand in drawn paving (fence at -5615,7620); 36 explained by the railway being over the road

### Turrella (7.95 km)
- **holes**: 6/314 bodies dropped through the surface they were standing on (worst 1.6 m); 2 invisible sheets over a carved corridor; 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 358 samples (worst 10.9 m)
- **tworld**: 0 carriage poses inside a building prism and 64 under drawn terrain, of 336 sampled within 300 m (T8:0 car 0 at -6247,6881 under drawn terrain)
- **vert**: 2/33 drawn track vertices sit more than a metre under uncarved terrain

### Croydon (8.40 km)
- **holes**: 1/314 bodies dropped through the surface they were standing on (worst 1.7 m); 2 invisible sheets over a carved corridor; client/server ground splits at 581 samples (worst 8.2 m)
- **clear**: 21 rail assets stand in drawn paving (fence at -8587,1822); 11 explained by the railway being over the road
- **ttt**: 182 carriage overlaps within 200 m, worst 19.1 m deep; commonest opposite-slot CCN:1 x T3:0 (182)
- **tworld**: 0 carriage poses inside a building prism and 99 under drawn terrain, of 670 sampled within 300 m (T2:1 car 1 at -8688,1735 under drawn terrain)
- **vert**: 4/102 drawn track vertices sit more than a metre under uncarved terrain

### Artarmon (8.61 km)
- **reach**: 1/2 decks reachable on foot; sealed at -2348,-6614
- **holes**: 2/314 bodies dropped through the surface they were standing on (worst 2.1 m); 7 of 14 bodies walked off the rim into the corridor; client/server ground splits at 446 samples (worst 5.5 m)
- **clear**: 24 rail assets stand in drawn paving (fence at -2191,-6509); 216 explained by the railway being over the road

### Canterbury (8.68 km)
- **holes**: 4/314 bodies dropped through the surface they were standing on (worst 2.0 m); 1 invisible sheets over a carved corridor; 4 of 14 bodies walked off the rim into the corridor; client/server ground splits at 206 samples (worst 7.4 m)
- **tworld**: 0 carriage poses inside a building prism and 75 under drawn terrain, of 378 sampled within 300 m (M1:0 car 4 at -8279,4957 under drawn terrain)
- **vert**: 2/54 drawn track vertices sit more than a metre under uncarved terrain

### Banksia (9.10 km)
- **holes**: 8 of 14 bodies walked off the rim into the corridor; client/server ground splits at 553 samples (worst 5.2 m)

### Bardwell Park (9.18 km)
- **holes**: 4/314 bodies dropped through the surface they were standing on (worst 1.5 m); 4 invisible sheets over a carved corridor; 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 372 samples (worst 13.4 m)
- **tworld**: 0 carriage poses inside a building prism and 54 under drawn terrain, of 338 sampled within 300 m (T8:0 car 0 at -7641,7087 under drawn terrain)

### Burwood (9.50 km)
- **holes**: 1/314 bodies dropped through the surface they were standing on (worst 4.7 m); 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 94 samples (worst 5.5 m)
- **clear**: 32 rail assets stand in drawn paving (fence at -10010,1026); 457 explained by the railway being over the road
- **ttt**: 1884 carriage overlaps within 200 m, worst 19.8 m deep; commonest opposite-slot CCN:0 x T9:1 (1474)
- **tworld**: 8 carriage poses inside a building prism and 26 under drawn terrain, of 1337 sampled within 300 m (T1:0 car 3 at -9432,1171 under drawn terrain)

### Rockdale (9.86 km)
- **holes**: 1/314 bodies dropped through the surface they were standing on (worst 1.7 m); 12 invisible sheets over a carved corridor; 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 158 samples (worst 5.5 m)
- **clear**: 77 rail assets stand in drawn paving (fence at -6515,9379); 29 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 42 under drawn terrain, of 504 sampled within 300 m (T4:0 car 0 at -6518,9362 under drawn terrain)

### Chatswood (9.93 km)
- **reach**: 0/3 decks reachable on foot; sealed at -2778,-7862 -2748,-7864 -2761,-7863
- **stand**: 2/3 decks walkable end to end; 2 lifted onto a solid (0.5 m up on a solid)
- **holes**: 11/314 bodies dropped through the surface they were standing on (worst 3.8 m); 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 21 samples (worst 4.4 m)
- **clear**: 25 rail assets stand in drawn paving (fence at -2778,-7734); 64 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 433 under drawn terrain, of 514 sampled within 300 m (M1:0 car 0 at -2761,-7852 under drawn terrain)
- **vert**: 39/62 drawn track vertices sit more than a metre under uncarved terrain

### Campsie (10.02 km)
- **holes**: 1/314 bodies dropped through the surface they were standing on (worst 5.3 m); 1 invisible sheets over a carved corridor; 5 of 14 bodies walked off the rim into the corridor; client/server ground splits at 229 samples (worst 10.3 m)
- **clear**: 1 rail assets stand in drawn paving (fence at -9500,4735)
- **tworld**: 0 carriage poses inside a building prism and 18 under drawn terrain, of 312 sampled within 300 m (M1:0 car 4 at -9643,4770 under drawn terrain)
- **vert**: 2/41 drawn track vertices sit more than a metre under uncarved terrain

### Bexley North (10.42 km)
- **holes**: 6/314 bodies dropped through the surface they were standing on (worst 1.6 m); 2 invisible sheets over a carved corridor; 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 334 samples (worst 12.2 m)
- **tworld**: 0 carriage poses inside a building prism and 70 under drawn terrain, of 336 sampled within 300 m (T8:0 car 0 at -8676,7779 under drawn terrain)
- **vert**: 3/39 drawn track vertices sit more than a metre under uncarved terrain

### Strathfield (10.47 km)
- **holes**: 4/314 bodies dropped through the surface they were standing on (worst 1.8 m); 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 504 samples (worst 4.1 m)
- **clear**: 359 rail assets stand in drawn paving (fence at -10750,378); 200 explained by the railway being over the road
- **ttt**: 255 carriage overlaps within 200 m, worst 19.6 m deep; commonest opposite-slot T1:0 x T3:1 (148)
- **tworld**: 218 carriage poses inside a building prism and 0 under drawn terrain, of 1357 sampled within 300 m (CCN:0 car 0 at -10569,541 through a prism)

### Kogarah (10.99 km)
- **stand**: 1/2 decks walkable end to end; 1 left the deck (6.06 m off)
- **holes**: 168/2511 drawn-ground samples unsupported (worst 5.9 m at -6897,10384); 18/314 bodies dropped through the surface they were standing on (worst 7.3 m); 6 of 14 bodies walked off the rim into the corridor; client/server ground splits at 114 samples (worst 7.6 m)
- **tworld**: 0 carriage poses inside a building prism and 45 under drawn terrain, of 246 sampled within 300 m (T4:0 car 2 at -6913,10559 under drawn terrain)

### Homebush (11.27 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 839 samples (worst 4.0 m)
- **clear**: 35 rail assets stand in drawn paving (fence at -11390,-25); 131 explained by the railway being over the road
- **ttt**: 4 carriage overlaps within 200 m, worst 8.3 m deep; commonest cross-line T1:0 x T3:1 (4)

### North Strathfield (11.30 km)
- **stand**: 1/2 decks walkable end to end; 1 lifted onto a solid (1.0 m up on a solid)
- **holes**: 1/2511 drawn-ground samples unsupported (worst 1.2 m at -11218,-857); 10 invisible sheets over a carved corridor; 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 375 samples (worst 9.7 m)
- **clear**: 37 rail assets stand in drawn paving (fence at -11224,-856); 66 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 38 under drawn terrain, of 668 sampled within 300 m (CCN:1 car 7 at -11284,-1079 under drawn terrain)
- **vert**: 2/47 drawn track vertices sit more than a metre under uncarved terrain

### Roseville (11.42 km)
- **reach**: 1/2 decks reachable on foot; sealed at -3099,-9317
- **holes**: 8 of 14 bodies walked off the rim into the corridor; client/server ground splits at 451 samples (worst 7.1 m)
- **tworld**: 11 carriage poses inside a building prism and 2 under drawn terrain, of 168 sampled within 300 m (T1:1 car 0 at -3344,-9465 under drawn terrain)

### Belmore (11.48 km)
- **holes**: 5/314 bodies dropped through the surface they were standing on (worst 1.6 m); 1 invisible sheets over a carved corridor; 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 285 samples (worst 8.7 m)
- **tworld**: 0 carriage poses inside a building prism and 75 under drawn terrain, of 381 sampled within 300 m (M1:1 car 4 at -11087,5579 under drawn terrain)

### Kingsgrove (11.59 km)
- **holes**: 2/314 bodies dropped through the surface they were standing on (worst 1.1 m); 4 invisible sheets over a carved corridor; 4 of 14 bodies walked off the rim into the corridor; client/server ground splits at 377 samples (worst 11.2 m)
- **tworld**: 0 carriage poses inside a building prism and 66 under drawn terrain, of 334 sampled within 300 m (T8:1 car 0 at -9885,8123 under drawn terrain)

### North Ryde (11.83 km)
- **holes**: 512/2511 drawn-ground samples unsupported (worst 13.9 m at -6812,-8162); 4/314 bodies dropped through the surface they were standing on (worst 14.4 m); client/server ground splits at 94 samples (worst 0.4 m)

### Concord West (11.87 km)
- **holes**: 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 437 samples (worst 4.0 m)
- **clear**: 16 rail assets stand in drawn paving (fence at -11506,-2217); 46 explained by the railway being over the road
- **ttt**: 4 carriage overlaps within 200 m, worst 11.1 m deep; commonest same-line-both-ways T9:0 x T9:1 (4)
- **tworld**: 16 carriage poses inside a building prism and 0 under drawn terrain, of 668 sampled within 300 m (CCN:0 car 0 at -11492,-1984 through a prism)

### Carlton (11.99 km)
- **holes**: 5 of 14 bodies walked off the rim into the corridor; client/server ground splits at 514 samples (worst 4.0 m)

### Lindfield (12.55 km)
- **holes**: 6 of 14 bodies walked off the rim into the corridor; client/server ground splits at 445 samples (worst 3.9 m)

### Rhodes (12.56 km)
- **holes**: 1/314 bodies dropped through the surface they were standing on (worst 2.1 m); 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 451 samples (worst 3.9 m)
- **clear**: 2/39 gauge probes hit a building prism (-11377,-4061 at -54.8 m); 112 explained by the railway being over the road
- **ttt**: 272 carriage overlaps within 200 m, worst 19.6 m deep; commonest opposite-slot CCN:1 x T9:0 (236)
- **tworld**: 54 carriage poses inside a building prism and 0 under drawn terrain, of 708 sampled within 300 m (T9:0 car 0 at -11374,-4076 through a prism)

### Lakemba (12.71 km)
- **holes**: 2/2511 drawn-ground samples unsupported (worst 0.6 m at -12171,5870); 3 invisible sheets over a carved corridor; 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 299 samples (worst 6.5 m)
- **clear**: 2 rail assets stand in drawn paving (platform at -12225,5903); 5 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 36 under drawn terrain, of 378 sampled within 300 m (M1:0 car 2 at -12195,5890 under drawn terrain)
- **vert**: 3/44 drawn track vertices sit more than a metre under uncarved terrain

### Allawah (12.72 km)
- **holes**: 59/2511 drawn-ground samples unsupported (worst 1.4 m at -8614,11341); 3/314 bodies dropped through the surface they were standing on (worst 1.4 m); 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 271 samples (worst 9.3 m)
- **clear**: 11 rail assets stand in drawn paving (fence at -8600,11366); 18 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 57 under drawn terrain, of 498 sampled within 300 m (T4:1 car 4 at -8559,11344 under drawn terrain)
- **vert**: 2/29 drawn track vertices sit more than a metre under uncarved terrain

### Flemington (12.81 km)
- **holes**: 1/314 bodies dropped through the surface they were standing on (worst 1.0 m); 1 invisible sheets over a carved corridor; 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 483 samples (worst 7.9 m)
- **clear**: 10 rail assets stand in drawn paving (fence at -12868,-201); 16 explained by the railway being over the road
- **ttt**: 753 carriage overlaps within 200 m, worst 19.8 m deep; commonest opposite-slot T2:0 x T2:1 (749)
- **tworld**: 0 carriage poses inside a building prism and 28 under drawn terrain, of 537 sampled within 300 m (T3:0 car 0 at -12872,-184 under drawn terrain)
- **vert**: 1/81 drawn track vertices sit more than a metre under uncarved terrain

### Meadowbank (13.18 km)
- **holes**: 4 of 14 bodies walked off the rim into the corridor; client/server ground splits at 231 samples (worst 6.2 m)
- **clear**: 9 rail assets stand in drawn paving (fence at -11122,-5695); 18 explained by the railway being over the road
- **ttt**: 2406 carriage overlaps within 200 m, worst 19.8 m deep; commonest opposite-slot CCN:0 x T9:1 (1452)
- **tworld**: 0 carriage poses inside a building prism and 26 under drawn terrain, of 668 sampled within 300 m (CCN:0 car 1 at -11155,-5540 under drawn terrain)
- **vert**: 2/50 drawn track vertices sit more than a metre under uncarved terrain

### Macquarie Park (13.18 km)
- **reach**: 0/2 decks reachable on foot; sealed at -7652,-9159 -7662,-9147

### Hurstville (13.31 km)
- **holes**: 5 invisible sheets over a carved corridor; 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 341 samples (worst 7.9 m)
- **clear**: 6 rail assets stand in drawn paving (fence at -9391,11215); 4 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 318 under drawn terrain, of 498 sampled within 300 m (T4:0 car 0 at -9756,11080 under drawn terrain)
- **vert**: 6/34 drawn track vertices sit more than a metre under uncarved terrain

### Olympic Park (13.35 km)
- **reach**: 0/1 decks reachable on foot; sealed at -12983,-2223
- **stand**: 0/1 decks walkable end to end; 2 left the deck (0.00 m off)

### Wiley Park (13.55 km)
- **stand**: 0/1 decks walkable end to end; 1 lifted onto a solid (2.1 m up on a solid)
- **holes**: 6 invisible sheets over a carved corridor; 4 of 14 bodies walked off the rim into the corridor; client/server ground splits at 163 samples (worst 6.8 m)
- **tworld**: 0 carriage poses inside a building prism and 33 under drawn terrain, of 378 sampled within 300 m (M1:0 car 0 at -12935,6207 under drawn terrain)
- **vert**: 2/29 drawn track vertices sit more than a metre under uncarved terrain

### Beverly Hills (13.63 km)
- **holes**: 1/314 bodies dropped through the surface they were standing on (worst 4.7 m); 3 invisible sheets over a carved corridor; 5 of 14 bodies walked off the rim into the corridor; client/server ground splits at 392 samples (worst 10.5 m)
- **tworld**: 0 carriage poses inside a building prism and 64 under drawn terrain, of 336 sampled within 300 m (T8:0 car 0 at -11730,9136 under drawn terrain)
- **vert**: 1/22 drawn track vertices sit more than a metre under uncarved terrain

### West Ryde (13.76 km)
- **holes**: client/server ground splits at 450 samples (worst 6.7 m)
- **clear**: 3 rail assets stand in drawn paving (fence at -11047,-6921); 138 explained by the railway being over the road

### Killara (13.83 km)
- **holes**: 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 442 samples (worst 4.2 m)
- **clear**: 47 rail assets stand in drawn paving (fence at -4608,-11347); 35 explained by the railway being over the road

### Penshurst (14.13 km)
- **holes**: 6/314 bodies dropped through the surface they were standing on (worst 1.5 m); 6 invisible sheets over a carved corridor; 4 of 14 bodies walked off the rim into the corridor; client/server ground splits at 353 samples (worst 9.9 m)
- **tworld**: 0 carriage poses inside a building prism and 120 under drawn terrain, of 498 sampled within 300 m (T4:1 car 0 at -10972,11004 under drawn terrain)
- **vert**: 1/35 drawn track vertices sit more than a metre under uncarved terrain

### Macquarie University (14.40 km)
- **holes**: 317/2511 drawn-ground samples unsupported (worst 14.9 m at -8607,-9964); 4/314 bodies dropped through the surface they were standing on (worst 15.2 m); client/server ground splits at 79 samples (worst 0.1 m)

### Narwee (14.41 km)
- **holes**: 1 invisible sheets over a carved corridor; client/server ground splits at 191 samples (worst 4.5 m)

### Denistone (14.47 km)
- **holes**: 15/2511 drawn-ground samples unsupported (worst 1.4 m at -11456,-7439); 1/314 bodies dropped through the surface they were standing on (worst 1.6 m); 8 invisible sheets over a carved corridor; 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 513 samples (worst 8.9 m)
- **clear**: 9 rail assets stand in drawn paving (fence at -11437,-7421); 1 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 98 under drawn terrain, of 672 sampled within 300 m (CCN:0 car 6 at -11474,-7456 under drawn terrain)

### Punchbowl (14.65 km)
- **holes**: 5/314 bodies dropped through the surface they were standing on (worst 1.5 m); 2 invisible sheets over a carved corridor; 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 229 samples (worst 8.9 m)
- **clear**: 3 rail assets stand in drawn paving (fence at -14012,6548)
- **tworld**: 0 carriage poses inside a building prism and 90 under drawn terrain, of 375 sampled within 300 m (M1:1 car 3 at -14096,6543 under drawn terrain)
- **vert**: 1/46 drawn track vertices sit more than a metre under uncarved terrain

### Mortdale (15.03 km)
- **holes**: 5 of 14 bodies walked off the rim into the corridor; client/server ground splits at 479 samples (worst 4.0 m)

### Lidcombe (15.06 km)
- **stand**: 4/5 decks walkable end to end; 1 left the deck (-6.64 m off)
- **holes**: 9/2511 drawn-ground samples unsupported (worst 1.2 m at -15174,-255); 2/314 bodies dropped through the surface they were standing on (worst 1.2 m); 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 552 samples (worst 7.6 m)
- **clear**: 2/169 gauge probes hit a building prism (-15243,-289 at -48.1 m); 52 rail assets stand in drawn paving (fence at -15248,-326); 311 explained by the railway being over the road
- **ttt**: 239 carriage overlaps within 200 m, worst 19.8 m deep; commonest opposite-slot T3:1 x T7:0 (127)
- **tworld**: 70 carriage poses inside a building prism and 98 under drawn terrain, of 1005 sampled within 300 m (T3:0 car 0 at -15239,-287 through a prism)
- **vert**: 10/169 drawn track vertices sit more than a metre under uncarved terrain

### Gordon (15.06 km)
- **holes**: 5/2511 drawn-ground samples unsupported (worst 0.7 m at -5365,-12500); client/server ground splits at 315 samples (worst 4.2 m)
- **clear**: 18 rail assets stand in drawn paving (fence at -5289,-12367); 54 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 3 under drawn terrain, of 167 sampled within 300 m (T1:0 car 2 at -5440,-12635 under drawn terrain)

### Eastwood (15.54 km)
- **stand**: 2/3 decks walkable end to end; 1 left the deck (-0.88 m off)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 568 samples (worst 7.0 m)
- **clear**: 36 rail assets stand in drawn paving (fence at -11903,-8512); 28 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 36 under drawn terrain, of 672 sampled within 300 m (T9:1 car 0 at -11875,-8261 under drawn terrain)

### Oatley (15.88 km)
- **stand**: 1/2 decks walkable end to end; 1 lifted onto a solid (7.2 m up on a solid)
- **holes**: 8 of 14 bodies walked off the rim into the corridor; client/server ground splits at 479 samples (worst 6.9 m)

### Riverwood (16.09 km)
- **holes**: 1 invisible sheets over a carved corridor; 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 300 samples (worst 8.2 m)
- **tworld**: 0 carriage poses inside a building prism and 54 under drawn terrain, of 332 sampled within 300 m (T8:0 car 0 at -14312,9423 under drawn terrain)
- **vert**: 1/21 drawn track vertices sit more than a metre under uncarved terrain

### Berala (16.17 km)
- **holes**: client/server ground splits at 262 samples (worst 4.5 m)
- **clear**: 7 rail assets stand in drawn paving (fence at -16329,623); 1 explained by the railway being over the road
- **ttt**: 262 carriage overlaps within 200 m, worst 19.6 m deep; commonest opposite-slot T3:0 x T3:1 (214)

### Bankstown (16.27 km)
- **holes**: 5/2511 drawn-ground samples unsupported (worst 0.6 m at -16129,5730); 7 invisible sheets over a carved corridor; 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 252 samples (worst 4.0 m)
- **clear**: 9 rail assets stand in drawn paving (fence at -16074,5740); 19 explained by the railway being over the road
- **ttt**: 546 carriage overlaps within 200 m, worst 21.4 m deep; commonest opposite-slot M1:0 x M1:1 (525)
- **tworld**: 34 carriage poses inside a building prism and 24 under drawn terrain, of 259 sampled within 300 m (M1:1 car 3 at -15968,5720 through a prism)
- **vert**: the bake's clearance is -4.80 m and the shipped DEM measures -0.13 m at the site; 2/50 drawn track vertices sit more than a metre under uncarved terrain

### Auburn (16.53 km)
- **holes**: 1/2511 drawn-ground samples unsupported (worst 1.0 m at -16331,-1792); 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 371 samples (worst 4.9 m)
- **clear**: 112 rail assets stand in drawn paving (fence at -16453,-1986); 57 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 21 under drawn terrain, of 335 sampled within 300 m (T1:0 car 0 at -16248,-1727 under drawn terrain)
- **vert**: 3/65 drawn track vertices sit more than a metre under uncarved terrain

### Pymble (16.61 km)
- **holes**: 36/2511 drawn-ground samples unsupported (worst 1.5 m at -6539,-13655); 3 invisible sheets over a carved corridor; 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 238 samples (worst 8.6 m)
- **clear**: 15 rail assets stand in drawn paving (fence at -6406,-13613)
- **tworld**: 0 carriage poses inside a building prism and 51 under drawn terrain, of 167 sampled within 300 m (T1:1 car 2 at -6529,-13681 under drawn terrain)
- **vert**: 8/31 drawn track vertices sit more than a metre under uncarved terrain

### Regents Park (16.85 km)
- **holes**: 3/2511 drawn-ground samples unsupported (worst 0.9 m at -17060,1796); 3/314 bodies dropped through the surface they were standing on (worst 1.5 m); 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 362 samples (worst 9.5 m)
- **ttt**: 216 carriage overlaps within 200 m, worst 19.7 m deep; commonest opposite-slot T3:0 x T3:1 (212)
- **tworld**: 0 carriage poses inside a building prism and 62 under drawn terrain, of 672 sampled within 300 m (T3:0 car 0 at -17156,1976 under drawn terrain)

### Birrong (16.89 km)
- **holes**: 8/2511 drawn-ground samples unsupported (worst 1.5 m at -17119,3085); 2 invisible sheets over a carved corridor; 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 525 samples (worst 11.0 m)
- **tworld**: 0 carriage poses inside a building prism and 52 under drawn terrain, of 652 sampled within 300 m (T6:1 car 0 at -17062,2965 under drawn terrain)

### Epping (16.90 km)
- **holes**: 46/2511 drawn-ground samples unsupported (worst 1.5 m at -11954,-10361); 1/314 bodies dropped through the surface they were standing on (worst 6.7 m); 1 invisible sheets over a carved corridor; 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 242 samples (worst 7.0 m)
- **clear**: 27 rail assets stand in drawn paving (fence at -11966,-10505); 53 explained by the railway being over the road
- **ttt**: 8 carriage overlaps within 200 m, worst 18.9 m deep; commonest same-line-both-ways CCN:0 x CCN:1 (8)
- **tworld**: 76 carriage poses inside a building prism and 232 under drawn terrain, of 678 sampled within 300 m (CCN:0 car 0 at -11944,-10359 under drawn terrain)
- **vert**: the bake's clearance is -5.39 m and the shipped DEM measures -2.01 m at the site; 8/83 drawn track vertices sit more than a metre under uncarved terrain

### Yagoona (17.02 km)
- **holes**: 5/314 bodies dropped through the surface they were standing on (worst 1.5 m); 3 invisible sheets over a carved corridor; 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 271 samples (worst 8.2 m)
- **clear**: 8 rail assets stand in drawn paving (fence at -17083,4463)
- **tworld**: 0 carriage poses inside a building prism and 54 under drawn terrain, of 336 sampled within 300 m (T6:0 car 0 at -17002,4587 under drawn terrain)

### Padstow (17.75 km)
- **holes**: 7/2511 drawn-ground samples unsupported (worst 1.3 m at -16136,9497); 4/314 bodies dropped through the surface they were standing on (worst 1.5 m); 3 invisible sheets over a carved corridor; 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 320 samples (worst 9.4 m)
- **tworld**: 0 carriage poses inside a building prism and 62 under drawn terrain, of 336 sampled within 300 m (T8:0 car 4 at -16226,9525 under drawn terrain)
- **vert**: 3/31 drawn track vertices sit more than a metre under uncarved terrain

### Sefton (18.03 km)
- **holes**: 1/2511 drawn-ground samples unsupported (worst 0.6 m at -18344,2164); client/server ground splits at 280 samples (worst 4.2 m)
- **clear**: 9 rail assets stand in drawn paving (fence at -18247,2182); 17 explained by the railway being over the road

### Telopea (18.27 km)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Clyde (18.33 km)
- **holes**: client/server ground splits at 415 samples (worst 4.0 m)
- **clear**: 26 rail assets stand in drawn paving (fence at -17868,-3320); 32 explained by the railway being over the road

### Dundas (18.36 km)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Turramurra (18.36 km)
- **holes**: 23/2511 drawn-ground samples unsupported (worst 1.5 m at -7820,-15052); 3/314 bodies dropped through the surface they were standing on (worst 1.5 m); 1 invisible sheets over a carved corridor; 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 160 samples (worst 6.8 m)
- **clear**: 5 rail assets stand in drawn paving (fence at -7789,-15011)
- **tworld**: 0 carriage poses inside a building prism and 35 under drawn terrain, of 167 sampled within 300 m (T1:0 car 0 at -7658,-14879 under drawn terrain)
- **vert**: 1/22 drawn track vertices sit more than a metre under uncarved terrain

### Yallamundi (18.36 km)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Rosehill Gardens (18.37 km)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Como (18.45 km)
- **holes**: 6/2511 drawn-ground samples unsupported (worst 0.9 m at -12736,15333); 1/314 bodies dropped through the surface they were standing on (worst 1.2 m); 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 373 samples (worst 5.7 m)
- **clear**: 9 rail assets stand in drawn paving (fence at -12772,15295); 38 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 12 under drawn terrain, of 501 sampled within 300 m (T4:0 car 4 at -12721,15398 under drawn terrain)
- **vert**: 1/30 drawn track vertices sit more than a metre under uncarved terrain

### Cheltenham (18.55 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 377 samples (worst 8.0 m)
- **clear**: 3 rail assets stand in drawn paving (fence at -12340,-12304); 6 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 118 under drawn terrain, of 672 sampled within 300 m (CCN:1 car 0 at -12390,-12363 under drawn terrain)
- **vert**: 3/62 drawn track vertices sit more than a metre under uncarved terrain

### Carlingford (18.61 km)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Granville (18.83 km)
- **holes**: 41/2511 drawn-ground samples unsupported (worst 1.5 m at -18369,-3650); client/server ground splits at 450 samples (worst 7.4 m)
- **clear**: 1/48 gauge probes hit a building prism (-18253,-3595 at -58.4 m); 58 rail assets stand in drawn paving (fence at -18225,-3588); 31 explained by the railway being over the road
- **tworld**: 46 carriage poses inside a building prism and 9 under drawn terrain, of 336 sampled within 300 m (T1:1 car 5 at -18279,-3620 through a prism)

### Tramway Avenue (18.92 km)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Chester Hill (19.15 km)
- **holes**: 1/314 bodies dropped through the surface they were standing on (worst 6.9 m); 7 invisible sheets over a carved corridor; 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 244 samples (worst 7.5 m)
- **tworld**: 0 carriage poses inside a building prism and 16 under drawn terrain, of 334 sampled within 300 m (T3:0 car 0 at -19272,2013 under drawn terrain)

### Revesby (19.25 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 199 samples (worst 4.0 m)
- **clear**: 5 rail assets stand in drawn paving (fence at -17784,9627); 51 explained by the railway being over the road

### Warrawee (19.43 km)
- **holes**: 13/2511 drawn-ground samples unsupported (worst 0.9 m at -8389,-15846); 7 invisible sheets over a carved corridor; 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 198 samples (worst 4.6 m)
- **clear**: 4 rail assets stand in drawn paving (fence at -8375,-15861)

### Robin Thomas (19.56 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Harris Park (19.60 km)
- **stand**: 1/3 decks walkable end to end; 1 lifted onto a solid (7.2 m up on a solid); 1 left the deck (-1.14 m off)
- **holes**: 16/2511 drawn-ground samples unsupported (worst 1.5 m at -18768,-4721); 1/314 bodies dropped through the surface they were standing on (worst 1.0 m); 1 invisible sheets over a carved corridor; 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 469 samples (worst 9.7 m)
- **clear**: 13 rail assets stand in drawn paving (fence at -18720,-4775); 70 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 54 under drawn terrain, of 335 sampled within 300 m (T1:1 car 3 at -18775,-4582 under drawn terrain)
- **vert**: 4/79 drawn track vertices sit more than a metre under uncarved terrain

### Jannali (19.61 km)
- **holes**: 2/2511 drawn-ground samples unsupported (worst 0.9 m at -13071,16555); 1 invisible sheets over a carved corridor; 5 of 14 bodies walked off the rim into the corridor; client/server ground splits at 220 samples (worst 9.2 m)
- **clear**: 12 rail assets stand in drawn paving (fence at -13065,16552)
- **tworld**: 0 carriage poses inside a building prism and 81 under drawn terrain, of 498 sampled within 300 m (T4:1 car 1 at -13078,16564 under drawn terrain)

### Beecroft (19.79 km)
- **holes**: 6/314 bodies dropped through the surface they were standing on (worst 1.5 m); 6 invisible sheets over a carved corridor; 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 499 samples (worst 7.2 m)
- **tworld**: 0 carriage poses inside a building prism and 56 under drawn terrain, of 676 sampled within 300 m (CCN:0 car 2 at -13504,-12823 under drawn terrain)

### Parramatta (20.03 km)
- **holes**: 1/314 bodies dropped through the surface they were standing on (worst 3.9 m); 5 of 14 bodies walked off the rim into the corridor; client/server ground splits at 406 samples (worst 6.6 m)
- **clear**: 5/98 gauge probes hit a building prism (-19058,-5381 at -46.8 m); 356 explained by the railway being over the road
- **tworld**: 58 carriage poses inside a building prism and 0 under drawn terrain, of 335 sampled within 300 m (T1:0 car 2 at -18992,-5366 through a prism)

### Parramatta Square (20.13 km)
- **holes**: 3/314 bodies dropped through the surface they were standing on (worst 1.6 m); 2 of 14 bodies walked off the rim into the corridor
- **clear**: 5/62 gauge probes hit a building prism (-19058,-5381 at -46.8 m); 179 explained by the railway being over the road
- **tworld**: 56 carriage poses inside a building prism and 0 under drawn terrain, of 282 sampled within 300 m (T1:0 car 2 at -18992,-5366 through a prism)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Wahroonga (20.28 km)
- **holes**: 2/2511 drawn-ground samples unsupported (worst 0.9 m at -8883,-16689); 4 invisible sheets over a carved corridor; 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 460 samples (worst 9.2 m)
- **clear**: 2 rail assets stand in drawn paving (fence at -8905,-16704)
- **tworld**: 0 carriage poses inside a building prism and 21 under drawn terrain, of 166 sampled within 300 m (T1:0 car 0 at -8794,-16560 under drawn terrain)

### Church Street (20.37 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Prince Alfred Square (20.41 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Pennant Hills (20.44 km)
- **holes**: 14/2511 drawn-ground samples unsupported (worst 1.5 m at -12927,-14285); 2 invisible sheets over a carved corridor; 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 308 samples (worst 9.5 m)
- **clear**: 6 rail assets stand in drawn paving (fence at -12918,-14304); 12 explained by the railway being over the road
- **ttt**: 386 carriage overlaps within 200 m, worst 19.7 m deep; commonest cross-line CCN:1 x T9:0 (386)
- **tworld**: 0 carriage poses inside a building prism and 104 under drawn terrain, of 668 sampled within 300 m (T9:0 car 0 at -12913,-14294 under drawn terrain)
- **vert**: 4/34 drawn track vertices sit more than a metre under uncarved terrain

### Leightonfield (20.46 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 244 samples (worst 3.9 m)
- **clear**: 83 rail assets stand in drawn paving (fence at -20748,1781); 5 explained by the railway being over the road

### Merrylands (20.50 km)
- **holes**: 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 231 samples (worst 4.0 m)
- **clear**: 41 rail assets stand in drawn paving (fence at -20181,-3118); 3 explained by the railway being over the road

### Fennell Street (20.54 km)
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Thornleigh (20.68 km)
- **holes**: 10 invisible sheets over a carved corridor; 5 of 14 bodies walked off the rim into the corridor; client/server ground splits at 227 samples (worst 6.1 m)
- **ttt**: 1478 carriage overlaps within 200 m, worst 19.8 m deep; commonest opposite-slot CCN:0 x T9:1 (1478)
- **tworld**: 0 carriage poses inside a building prism and 54 under drawn terrain, of 668 sampled within 300 m (CCN:0 car 2 at -12425,-14950 under drawn terrain)
- **vert**: 1/46 drawn track vertices sit more than a metre under uncarved terrain

### Normanhurst (20.78 km)
- **holes**: 3/314 bodies dropped through the surface they were standing on (worst 1.4 m); 6 invisible sheets over a carved corridor; 5 of 14 bodies walked off the rim into the corridor; client/server ground splits at 297 samples (worst 8.7 m)
- **ttt**: 214 carriage overlaps within 200 m, worst 19.5 m deep; commonest opposite-slot CCN:0 x CCN:1 (178)
- **tworld**: 0 carriage poses inside a building prism and 90 under drawn terrain, of 670 sampled within 300 m (T9:0 car 1 at -10699,-16210 under drawn terrain)
- **vert**: 4/58 drawn track vertices sit more than a metre under uncarved terrain

### Panania (20.79 km)
- **holes**: 8 of 14 bodies walked off the rim into the corridor; client/server ground splits at 477 samples (worst 6.7 m)

### Guildford (20.80 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 258 samples (worst 5.2 m)

### Benaud Oval (20.86 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Ngara (21.09 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Villawood (21.30 km)
- **holes**: 6/314 bodies dropped through the surface they were standing on (worst 1.5 m); 1 invisible sheets over a carved corridor; 4 of 14 bodies walked off the rim into the corridor; client/server ground splits at 361 samples (worst 9.2 m)
- **tworld**: 0 carriage poses inside a building prism and 24 under drawn terrain, of 334 sampled within 300 m (T3:1 car 2 at -21377,1726 under drawn terrain)

### Sutherland (21.37 km)
- **holes**: 4/314 bodies dropped through the surface they were standing on (worst 1.6 m); 2 invisible sheets over a carved corridor; 12 of 14 bodies walked off the rim into the corridor; client/server ground splits at 215 samples (worst 7.3 m)
- **tworld**: 0 carriage poses inside a building prism and 90 under drawn terrain, of 501 sampled within 300 m (T4:0 car 5 at -13704,18286 under drawn terrain)
- **vert**: 2/22 drawn track vertices sit more than a metre under uncarved terrain

### Waitara (21.54 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 484 samples (worst 4.0 m)
- **clear**: 42 rail assets stand in drawn paving (fence at -10030,-17409); 24 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 4 under drawn terrain, of 166 sampled within 300 m (T1:1 car 1 at -10227,-17606 under drawn terrain)

### Childrens Hospital (21.74 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Yennora (21.88 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 243 samples (worst 4.0 m)
- **clear**: 12 rail assets stand in drawn paving (coping at -22068,-19); 7 explained by the railway being over the road

### Westmead Hospital (21.89 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor
- **vert**: vertical is 'unknown': the profile was never measured here, so nothing derives the label

### Westmead (21.93 km)
- **stand**: 1/3 decks walkable end to end; 1 lifted onto a solid (4.3 m up on a solid); 1 left the deck (-1.02 m off)
- **holes**: 1/2511 drawn-ground samples unsupported (worst 1.3 m at -20566,-6318); 5/314 bodies dropped through the surface they were standing on (worst 3.2 m); 1 invisible sheets over a carved corridor; 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 558 samples (worst 9.3 m)
- **clear**: 1/57 gauge probes hit a building prism (-20641,-6308 at -34.2 m); 14 rail assets stand in drawn paving (fence at -20381,-6194); 35 explained by the railway being over the road
- **tworld**: 16 carriage poses inside a building prism and 96 under drawn terrain, of 335 sampled within 300 m (T5:0 car 0 at -20676,-6347 under drawn terrain)

### East Hills (22.23 km)
- **holes**: 2/314 bodies dropped through the surface they were standing on (worst 7.8 m); 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 265 samples (worst 8.0 m)

### Hornsby (22.42 km)
- **holes**: 5/2511 drawn-ground samples unsupported (worst 0.9 m at -10591,-18195); 8/314 bodies dropped through the surface they were standing on (worst 7.8 m); 2 invisible sheets over a carved corridor; client/server ground splits at 322 samples (worst 9.0 m)
- **clear**: 12/98 gauge probes hit a building prism (-10597,-18141 at 117.6 m); 65 rail assets stand in drawn paving (fence at -10580,-18167); 25 explained by the railway being over the road
- **tworld**: 164 carriage poses inside a building prism and 105 under drawn terrain, of 645 sampled within 300 m (T1:1 car 3 at -10594,-18137 through a prism)
- **vert**: 8/98 drawn track vertices sit more than a metre under uncarved terrain

### Carramar (22.65 km)
- **holes**: client/server ground splits at 407 samples (worst 3.9 m)

### Loftus (22.89 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 222 samples (worst 4.0 m)

### Cherrybrook (23.02 km)
- **stand**: 0/2 decks walkable end to end; 2 left the deck (0.10 m off)
- **holes**: 157/2511 drawn-ground samples unsupported (worst 6.9 m at -16693,-14375); 2/314 bodies dropped through the surface they were standing on (worst 9.7 m); 2 invisible sheets over a carved corridor; client/server ground splits at 105 samples (worst 13.3 m)

### Fairfield (23.11 km)
- **holes**: 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 239 samples (worst 3.6 m)
- **clear**: 23 rail assets stand in drawn paving (fence at -23359,849); 8 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 27 under drawn terrain, of 334 sampled within 300 m (T2:1 car 0 at -23504,1017 under drawn terrain)
- **vert**: 4/52 drawn track vertices sit more than a metre under uncarved terrain

### Wentworthville (23.27 km)
- **holes**: 5 of 14 bodies walked off the rim into the corridor; client/server ground splits at 667 samples (worst 4.2 m)
- **clear**: 23 rail assets stand in drawn paving (fence at -22067,-6435); 152 explained by the railway being over the road

### Asquith (23.55 km)
- **holes**: 6/314 bodies dropped through the surface they were standing on (worst 1.3 m); 2 invisible sheets over a carved corridor; 5 of 14 bodies walked off the rim into the corridor; client/server ground splits at 228 samples (worst 6.1 m)
- **clear**: 2 rail assets stand in drawn paving (fence at -9780,-19729)
- **ttt**: 1564 carriage overlaps within 200 m, worst 19.8 m deep; commonest opposite-slot CCN:0 x CCN:1 (1482)
- **tworld**: 0 carriage poses inside a building prism and 43 under drawn terrain, of 501 sampled within 300 m (CCN:0 car 2 at -9690,-19870 under drawn terrain)

### Canley Vale (24.31 km)
- **holes**: 22/2511 drawn-ground samples unsupported (worst 1.0 m at -24540,2500); 1 invisible sheets over a carved corridor; 6 of 14 bodies walked off the rim into the corridor; client/server ground splits at 21 samples (worst 6.8 m)
- **clear**: 6 rail assets stand in drawn paving (fence at -24528,2479); 2 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 41 under drawn terrain, of 389 sampled within 300 m (T5:0 car 3 at -24538,2505 under drawn terrain)
- **vert**: 2/44 drawn track vertices sit more than a metre under uncarved terrain

### Holsworthy (24.71 km)
- **holes**: 8/2511 drawn-ground samples unsupported (worst 1.0 m at -23256,10911); 2/314 bodies dropped through the surface they were standing on (worst 1.5 m); 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 276 samples (worst 7.9 m)
- **clear**: 4 rail assets stand in drawn paving (fence at -23183,10890)
- **tworld**: 0 carriage poses inside a building prism and 42 under drawn terrain, of 332 sampled within 300 m (T8:0 car 5 at -23071,10910 under drawn terrain)

### Cabramatta (24.78 km)
- **holes**: 5/314 bodies dropped through the surface they were standing on (worst 4.0 m); 3 invisible sheets over a carved corridor; 6 of 14 bodies walked off the rim into the corridor; client/server ground splits at 239 samples (worst 8.8 m)
- **clear**: 25 rail assets stand in drawn paving (fence at -24927,3169)
- **ttt**: 769 carriage overlaps within 200 m, worst 19.8 m deep; commonest opposite-slot T2:0 x T5:0 (769)
- **tworld**: 18 carriage poses inside a building prism and 78 under drawn terrain, of 672 sampled within 300 m (T3:1 car 5 at -24957,3345 through a prism)

### Pendle Hill (24.90 km)
- **holes**: 1/314 bodies dropped through the surface they were standing on (worst 2.4 m); 26 invisible sheets over a carved corridor; 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 466 samples (worst 6.8 m)
- **clear**: 36 rail assets stand in drawn paving (fence at -23575,-7078); 54 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 8 under drawn terrain, of 334 sampled within 300 m (T1:1 car 0 at -23353,-6899 under drawn terrain)

### Castle Hill (25.02 km)
- **holes**: 46/2511 drawn-ground samples unsupported (worst 8.4 m at -18929,-14878); 5/314 bodies dropped through the surface they were standing on (worst 8.6 m); 2 of 14 bodies walked off the rim into the corridor

### Mount Colah (25.06 km)
- **holes**: 7 of 14 bodies walked off the rim into the corridor; client/server ground splits at 524 samples (worst 4.0 m)
- **ttt**: 648 carriage overlaps within 200 m, worst 19.6 m deep; commonest opposite-slot CCN:0 x CCN:1 (648)

### Warwick Farm (25.30 km)
- **holes**: 3/314 bodies dropped through the surface they were standing on (worst 1.4 m); 1 invisible sheets over a carved corridor; 9 of 14 bodies walked off the rim into the corridor; client/server ground splits at 219 samples (worst 7.1 m)
- **ttt**: 1910 carriage overlaps within 200 m, worst 19.8 m deep; commonest opposite-slot T3:1 x T5:1 (690)
- **tworld**: 0 carriage poses inside a building prism and 143 under drawn terrain, of 666 sampled within 300 m (T2:0 car 0 at -25259,5343 under drawn terrain)
- **vert**: 6/48 drawn track vertices sit more than a metre under uncarved terrain

### Toongabbie (25.93 km)
- **holes**: 12/2511 drawn-ground samples unsupported (worst 1.1 m at -24039,-8493); 39 invisible sheets over a carved corridor; 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 230 samples (worst 7.0 m)
- **clear**: 59 rail assets stand in drawn paving (fence at -24038,-8566); 10 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 33 under drawn terrain, of 333 sampled within 300 m (T5:1 car 3 at -24050,-8581 under drawn terrain)
- **vert**: 3/53 drawn track vertices sit more than a metre under uncarved terrain

### Liverpool (26.16 km)
- **stand**: 2/3 decks walkable end to end; 1 left the deck (-0.94 m off)
- **holes**: 16/2511 drawn-ground samples unsupported (worst 1.3 m at -25963,6693); 3/314 bodies dropped through the surface they were standing on (worst 3.8 m); 16 invisible sheets over a carved corridor; client/server ground splits at 396 samples (worst 8.2 m)
- **clear**: 16 rail assets stand in drawn paving (fence at -25951,6701); 1 explained by the railway being over the road
- **tworld**: 12 carriage poses inside a building prism and 60 under drawn terrain, of 452 sampled within 300 m (T3:1 car 1 at -25922,6683 under drawn terrain)

### Mount Kuring-gai (26.45 km)
- **holes**: 8 of 14 bodies walked off the rim into the corridor; client/server ground splits at 436 samples (worst 5.8 m)

### Hills Showground (26.70 km)
- **stand**: 0/2 decks walkable end to end; 2 left the deck (0.12 m off)
- **holes**: 252/2511 drawn-ground samples unsupported (worst 15.2 m at -20837,-15249); 1/314 bodies dropped through the surface they were standing on (worst 15.2 m); client/server ground splits at 62 samples (worst 0.1 m)

### Engadine (26.97 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 279 samples (worst 5.5 m)
- **clear**: 46 rail assets stand in drawn paving (fence at -17416,22197); 19 explained by the railway being over the road

### Seven Hills (27.83 km)
- **stand**: 2/3 decks walkable end to end; 1 lifted onto a solid (7.2 m up on a solid)
- **holes**: 9/314 bodies dropped through the surface they were standing on (worst 7.1 m); 3 invisible sheets over a carved corridor; client/server ground splits at 449 samples (worst 9.5 m)
- **tworld**: 0 carriage poses inside a building prism and 36 under drawn terrain, of 334 sampled within 300 m (T5:0 car 0 at -25544,-10024 under drawn terrain)
- **vert**: 2/46 drawn track vertices sit more than a metre under uncarved terrain

### Norwest (27.95 km)
- **holes**: 205/2511 drawn-ground samples unsupported (worst 13.3 m at -22949,-14536); 2/314 bodies dropped through the surface they were standing on (worst 13.4 m); 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 29 samples (worst 0.3 m)

### Casula (28.20 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 273 samples (worst 4.3 m)

### Heathcote (29.07 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 274 samples (worst 5.7 m)
- **ttt**: 246 carriage overlaps within 200 m, worst 18.8 m deep; commonest same-line-both-ways T4:0 x T4:1 (246)

### Berowra (29.35 km)
- **holes**: 10/2511 drawn-ground samples unsupported (worst 1.2 m at -5629,-27166); 4 of 14 bodies walked off the rim into the corridor; client/server ground splits at 443 samples (worst 5.1 m)
- **tworld**: 0 carriage poses inside a building prism and 2 under drawn terrain, of 413 sampled within 300 m (CCN:0 car 6 at -5835,-26985 under drawn terrain)

### Bella Vista (29.69 km)
- **holes**: 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 461 samples (worst 11.9 m)
- **tworld**: 0 carriage poses inside a building prism and 51 under drawn terrain, of 300 sampled within 300 m (M1:1 car 1 at -24864,-14895 under drawn terrain)
- **vert**: 2/20 drawn track vertices sit more than a metre under uncarved terrain

### Blacktown (30.51 km)
- **stand**: 2/3 decks walkable end to end; 1 lifted onto a solid (7.6 m up on a solid)
- **holes**: 5/2511 drawn-ground samples unsupported (worst 0.8 m at -28067,-10584); 7 invisible sheets over a carved corridor; client/server ground splits at 330 samples (worst 6.4 m)
- **clear**: 28 rail assets stand in drawn paving (fence at -28256,-10617); 106 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 20 under drawn terrain, of 333 sampled within 300 m (T1:1 car 1 at -28183,-10588 under drawn terrain)

### Glenfield (30.56 km)
- **holes**: client/server ground splits at 588 samples (worst 4.0 m)
- **clear**: 83 rail assets stand in drawn paving (fence at -29019,12010); 155 explained by the railway being over the road
- **ttt**: 766 carriage overlaps within 200 m, worst 19.8 m deep; commonest opposite-slot T5:1 x T8:1 (766)

### Kellyville (31.50 km)
- **holes**: 4/314 bodies dropped through the surface they were standing on (worst 6.5 m); 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 45 samples (worst 10.4 m)

### Marayong (32.23 km)
- **holes**: 8 of 14 bodies walked off the rim into the corridor; client/server ground splits at 478 samples (worst 6.1 m)

### Macquarie Fields (32.26 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 215 samples (worst 3.9 m)
- **clear**: 2 rail assets stand in drawn paving (platform at -30323,13468); 50 explained by the railway being over the road

### Cowan (32.47 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 237 samples (worst 4.1 m)
- **clear**: 8 rail assets stand in drawn paving (fence at -4019,-30444); 18 explained by the railway being over the road

### Edmondson Park (33.51 km)
- **reach**: 1/2 decks reachable on foot; sealed at -32211,11773
- **holes**: 3/2511 drawn-ground samples unsupported (worst 1.5 m at -32184,11763); 1/314 bodies dropped through the surface they were standing on (worst 4.3 m); 3 invisible sheets over a carved corridor; client/server ground splits at 207 samples (worst 6.6 m)
- **tworld**: 0 carriage poses inside a building prism and 67 under drawn terrain, of 335 sampled within 300 m (T5:0 car 0 at -32420,11719 under drawn terrain)

### Rouse Hill (33.76 km)
- **holes**: 2/314 bodies dropped through the surface they were standing on (worst 5.6 m); 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 36 samples (worst 9.1 m)

### Waterfall (33.95 km)
- **holes**: 113/2511 drawn-ground samples unsupported (worst 1.4 m at -19288,29907); 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 199 samples (worst 7.3 m)
- **tworld**: 0 carriage poses inside a building prism and 36 under drawn terrain, of 198 sampled within 300 m (T4:0 car 4 at -19302,29834 under drawn terrain)
- **vert**: 1/21 drawn track vertices sit more than a metre under uncarved terrain

### Ingleburn (33.96 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 231 samples (worst 4.0 m)
- **clear**: 48 rail assets stand in drawn paving (fence at -31541,14842); 105 explained by the railway being over the road

### Doonside (34.03 km)
- **holes**: 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 224 samples (worst 3.9 m)
- **clear**: 15 rail assets stand in drawn paving (fence at -31744,-11023); 10 explained by the railway being over the road

### Quakers Hill (34.35 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 349 samples (worst 3.9 m)
- **clear**: 142 rail assets stand in drawn paving (fence at -30207,-15135); 33 explained by the railway being over the road
- **tworld**: 1 carriage poses inside a building prism and 0 under drawn terrain, of 167 sampled within 300 m (T5:0 car 6 at -30213,-15126 through a prism)

### Tallawong (35.11 km)
- **holes**: 52/2511 drawn-ground samples unsupported (worst 1.5 m at -28522,-19115); 2/314 bodies dropped through the surface they were standing on (worst 1.6 m); 6 invisible sheets over a carved corridor; 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 129 samples (worst 8.3 m)
- **clear**: 17 rail assets stand in drawn paving (fence at -28485,-19109); 27 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 42 under drawn terrain, of 150 sampled within 300 m (M1:1 car 2 at -28382,-19153 under drawn terrain)
- **vert**: the bake's clearance is -7.98 m and the shipped DEM measures -4.89 m at the site; 4/12 drawn track vertices sit more than a metre under uncarved terrain

### Rooty Hill (35.72 km)
- **holes**: 10 of 14 bodies walked off the rim into the corridor; client/server ground splits at 338 samples (worst 7.6 m)
- **clear**: 3 rail assets stand in drawn paving (platform at -33961,-10120); 16 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 10 under drawn terrain, of 168 sampled within 300 m (T1:1 car 5 at -33679,-10247 under drawn terrain)

### Schofields (36.72 km)
- **holes**: 1/314 bodies dropped through the surface they were standing on (worst 2.7 m); client/server ground splits at 382 samples (worst 3.9 m)
- **clear**: 6 rail assets stand in drawn paving (fence at -31380,-17596); 116 explained by the railway being over the road

### Minto (37.17 km)
- **holes**: 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 251 samples (worst 4.0 m)
- **clear**: 23 rail assets stand in drawn paving (fence at -33569,18304); 9 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 8 under drawn terrain, of 336 sampled within 300 m (T8:0 car 6 at -33627,18471 under drawn terrain)

### Hawkesbury River (37.46 km)
- **holes**: 6 of 14 bodies walked off the rim into the corridor; client/server ground splits at 427 samples (worst 10.0 m)
- **tworld**: 0 carriage poses inside a building prism and 10 under drawn terrain, of 336 sampled within 300 m (CCN:0 car 3 at 687,-35623 under drawn terrain)

### Leppington (37.65 km)
- **holes**: 33/2511 drawn-ground samples unsupported (worst 1.4 m at -36963,10210); 3/314 bodies dropped through the surface they were standing on (worst 2.3 m); 1 invisible sheets over a carved corridor; 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 92 samples (worst 6.8 m)
- **tworld**: 20 carriage poses inside a building prism and 58 under drawn terrain, of 132 sampled within 300 m (T2:0 car 3 at -36907,10215 under drawn terrain)
- **vert**: 4/29 drawn track vertices sit more than a metre under uncarved terrain

### Mount Druitt (37.95 km)
- **holes**: 1/314 bodies dropped through the surface they were standing on (worst 4.3 m); 1 invisible sheets over a carved corridor; 8 of 14 bodies walked off the rim into the corridor; client/server ground splits at 241 samples (worst 8.4 m)
- **tworld**: 0 carriage poses inside a building prism and 20 under drawn terrain, of 168 sampled within 300 m (T1:1 car 0 at -36255,-10309 under drawn terrain)

### Riverstone (39.32 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 195 samples (worst 4.1 m)
- **clear**: 20 rail assets stand in drawn paving (fence at -32713,-20426); 54 explained by the railway being over the road

### Leumeah (39.34 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 205 samples (worst 4.1 m)
- **clear**: 20 rail assets stand in drawn paving (fence at -34619,20878); 2 explained by the railway being over the road

### Otford (40.65 km)
- **holes**: 2 of 14 bodies walked off the rim into the corridor

### Campbelltown (41.32 km)
- **holes**: 14 invisible sheets over a carved corridor; 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 149 samples (worst 4.3 m)
- **clear**: 16 rail assets stand in drawn paving (fence at -36065,22305); 12 explained by the railway being over the road
- **ttt**: 146 carriage overlaps within 200 m, worst 19.5 m deep; commonest same-line-both-ways T8:0 x T8:1 (146)
- **tworld**: 0 carriage poses inside a building prism and 6 under drawn terrain, of 336 sampled within 300 m (T8:0 car 6 at -36103,22357 under drawn terrain)

### Vineyard (41.91 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 274 samples (worst 4.0 m)

### St Marys (42.17 km)
- **holes**: 1/314 bodies dropped through the surface they were standing on (worst 2.6 m); 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 154 samples (worst 2.9 m)
- **clear**: 16 rail assets stand in drawn paving (fence at -40413,-11040); 17 explained by the railway being over the road

### Macarthur (43.15 km)
- **stand**: 0/1 decks walkable end to end; 1 left the deck (3.03 m off)
- **holes**: 3 invisible sheets over a carved corridor; 7 of 14 bodies walked off the rim into the corridor; client/server ground splits at 110 samples (worst 5.1 m)
- **tworld**: 20 carriage poses inside a building prism and 38 under drawn terrain, of 134 sampled within 300 m (T8:0 car 4 at -37628,23275 through a prism)

### Stanwell Park (43.26 km)
- **holes**: 3 of 14 bodies walked off the rim into the corridor

### Werrington (43.78 km)
- **holes**: 47 invisible sheets over a carved corridor; 7 of 14 bodies walked off the rim into the corridor; client/server ground splits at 103 samples (worst 4.9 m)
- **clear**: 18 rail assets stand in drawn paving (fence at -42069,-11334); 3 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 4 under drawn terrain, of 167 sampled within 300 m (T1:1 car 1 at -41787,-11290 under drawn terrain)

### Coalcliff (44.96 km)
- **holes**: 3 of 14 bodies walked off the rim into the corridor

### Mulgrave (45.06 km)
- **holes**: client/server ground splits at 438 samples (worst 4.0 m)

### Woy Woy (45.51 km)
- **holes**: 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 290 samples (worst 4.5 m)
- **clear**: 20 rail assets stand in drawn paving (fence at 9857,-42656); 26 explained by the railway being over the road

### Kingswood (47.16 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 256 samples (worst 4.1 m)
- **clear**: 30 rail assets stand in drawn paving (fence at -45524,-11370); 53 explained by the railway being over the road

### Windsor (47.37 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 312 samples (worst 4.9 m)
- **clear**: 10 rail assets stand in drawn paving (fence at -37475,-27607); 2 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 1 under drawn terrain, of 167 sampled within 300 m (T5:1 car 3 at -37631,-27646 under drawn terrain)
- **vert**: 2/42 drawn track vertices sit more than a metre under uncarved terrain

### Koolewong (47.52 km)
- **holes**: 22/2511 drawn-ground samples unsupported (worst 1.5 m at 9363,-44823); 5 invisible sheets over a carved corridor; 4 of 14 bodies walked off the rim into the corridor; client/server ground splits at 232 samples (worst 6.9 m)
- **clear**: 4 rail assets stand in drawn paving (fence at 9369,-44843)
- **tworld**: 0 carriage poses inside a building prism and 46 under drawn terrain, of 338 sampled within 300 m (CCN:0 car 5 at 9366,-44821 under drawn terrain)
- **vert**: the bake's clearance is 0.00 m and the shipped DEM measures -3.82 m at the site; 4/40 drawn track vertices sit more than a metre under uncarved terrain

### Scarborough (47.69 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor

### Tascott (49.20 km)
- **holes**: 3/2511 drawn-ground samples unsupported (worst 1.3 m at 9350,-46511); 4/314 bodies dropped through the surface they were standing on (worst 1.5 m); 2 invisible sheets over a carved corridor; 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 246 samples (worst 7.1 m)
- **tworld**: 0 carriage poses inside a building prism and 38 under drawn terrain, of 338 sampled within 300 m (CCN:1 car 3 at 9368,-46515 under drawn terrain)
- **vert**: the bake's clearance is 1.74 m and the shipped DEM measures -2.75 m at the site

### Wombarra (49.29 km)
- **holes**: 3 of 14 bodies walked off the rim into the corridor

### Clarendon (49.39 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 275 samples (worst 3.9 m)
- **clear**: 11 rail assets stand in drawn paving (fence at -39604,-28114); 11 explained by the railway being over the road

### Penrith (49.55 km)
- **holes**: client/server ground splits at 358 samples (worst 4.0 m)
- **clear**: 27 rail assets stand in drawn paving (fence at -47955,-12278); 18 explained by the railway being over the road
- **tworld**: 1 carriage poses inside a building prism and 0 under drawn terrain, of 167 sampled within 300 m (T1:0 car 2 at -47744,-12235 through a prism)

### Point Clare (49.91 km)
- **holes**: 3/2511 drawn-ground samples unsupported (worst 0.7 m at 10239,-46978); 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 195 samples (worst 4.1 m)
- **clear**: 1 rail assets stand in drawn paving (platform at 10252,-47044); 18 explained by the railway being over the road
- **tworld**: 0 carriage poses inside a building prism and 4 under drawn terrain, of 334 sampled within 300 m (CCN:0 car 1 at 10119,-46796 under drawn terrain)

### Emu Plains (51.87 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 274 samples (worst 8.6 m)

### East Richmond (51.97 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 324 samples (worst 3.9 m)
- **clear**: 4 rail assets stand in drawn paving (fence at -42470,-28871); 23 explained by the railway being over the road
- **ttt**: 420 carriage overlaps within 200 m, worst 19.8 m deep; commonest opposite-slot T5:0 x T5:1 (420)

### Richmond (52.64 km)
- **holes**: client/server ground splits at 552 samples (worst 3.9 m)
- **clear**: 19 rail assets stand in drawn paving (fence at -42666,-28978); 13 explained by the railway being over the road

### Gosford (52.65 km)
- **holes**: 9/2511 drawn-ground samples unsupported (worst 1.5 m at 11463,-49578); 6 invisible sheets over a carved corridor; 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 424 samples (worst 7.7 m)
- **clear**: 4 rail assets stand in drawn paving (fence at 11447,-49580)
- **tworld**: 0 carriage poses inside a building prism and 32 under drawn terrain, of 338 sampled within 300 m (CCN:1 car 2 at 11461,-49587 under drawn terrain)
- **vert**: the bake's clearance is 0.00 m and the shipped DEM measures -3.12 m at the site

### Lapstone (53.61 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor

### Narara (55.80 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 209 samples (worst 6.8 m)
- **clear**: 19 rail assets stand in drawn paving (fence at 11680,-52790); 7 explained by the railway being over the road

### Niagara Park (57.27 km)
- **holes**: 2 of 14 bodies walked off the rim into the corridor; client/server ground splits at 352 samples (worst 4.2 m)
- **clear**: 25 rail assets stand in drawn paving (fence at 12581,-54078)

### Blaxland (57.42 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor

### Lisarow (57.73 km)
- **holes**: 1 of 14 bodies walked off the rim into the corridor; client/server ground splits at 206 samples (worst 6.8 m)
- **clear**: 13 rail assets stand in drawn paving (fence at 14042,-54215); 9 explained by the railway being over the road

### Ourimbah (60.15 km)
- **holes**: 18 invisible sheets over a carved corridor; 3 of 14 bodies walked off the rim into the corridor; client/server ground splits at 229 samples (worst 14.0 m)
- **tworld**: 0 carriage poses inside a building prism and 26 under drawn terrain, of 118 sampled within 300 m (CCN:1 car 1 at 13979,-56690 under drawn terrain)
- **vert**: the bake's clearance is 0.00 m and the shipped DEM measures -11.27 m at the site
