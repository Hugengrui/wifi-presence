package hostapd

import "testing"

func TestStatusParse(t *testing.T) {
	var got Status
	if err := got.parse([]byte(statusMsg)); err != nil {
		t.Fatal(err)
	}

	expected := Status{
		State:      "ENABLED",
		Channel:    52,
		MaxTxPower: 23,
		SSID:       "🌝",
		BSSID:      "aa:bb:cc:ee:12:34",
	}
	if got != expected {
		t.Fatalf("got:\n%#v\nexpected:\n%#v", got, expected)
	}
	t.Logf("got:\n%#v", got)
}

func TestStatusParseVendorStats(t *testing.T) {
	var got Status
	if err := got.parse([]byte(statusMsgVendorStats)); err != nil {
		t.Fatal(err)
	}

	expected := Status{
		State:      "ENABLED",
		Channel:    40,
		MaxTxPower: 23,
		SSID:       "PDCN_5G",
		BSSID:      "00:03:7f:12:da:da",
	}
	if got != expected {
		t.Fatalf("got:\n%#v\nexpected:\n%#v", got, expected)
	}
}

const statusMsg = `state=ENABLED
phy=phy0
freq=5260
num_sta_non_erp=0
num_sta_no_short_slot_time=5
num_sta_no_short_preamble=5
olbc=0
num_sta_ht_no_gf=5
num_sta_no_ht=0
num_sta_ht_20_mhz=1
num_sta_ht40_intolerant=0
olbc_ht=0
ht_op_mode=0x6
cac_time_seconds=60
cac_time_left_seconds=N/A
channel=52
secondary_channel=1
ieee80211n=1
ieee80211ac=1
ieee80211ax=0
beacon_int=100
dtim_period=2
vht_oper_chwidth=0
vht_oper_centr_freq_seg0_idx=54
vht_oper_centr_freq_seg1_idx=0
vht_caps_info=338001b2
rx_vht_mcs_map=fffa
tx_vht_mcs_map=fffa
ht_caps_info=09ef
ht_mcs_bitmask=ffff0000000000000000
supported_rates=0c 12 18 24 30 48 60 6c
max_txpower=23
bss[0]=wlan0
bssid[0]=aa:bb:cc:ee:12:34
ssid[0]=\xf0\x9f\x8c\x9d
num_sta[0]=5
chan_util_avg=96`

const statusMsgVendorStats = `state=ENABLED
phy=ath1
freq=5200
channel=40
max_txpower=23
bss[0]=ath1
bssid[0]=00:03:7f:12:da:da
ssid[0]=PDCN_5G
num_sta[0]=1
---- TOTAL PACKET COUNT -----------
Total received packets total_rx = 1366
---- TRANSMITTED PACKETS ----------
auth_resp   = 100
assoc_resp  = 99`

func TestDecodeSSID(t *testing.T) {
	cases := []struct {
		name  string
		input []byte
		want  string
	}{
		{
			name:  "ascii",
			input: []byte("hello world"),
			want:  "hello world",
		},
		{
			name:  "ascii",
			input: []byte("123!@#$%^)"),
			want:  "123!@#$%^)",
		},
		{
			name:  "emoji",
			input: []byte("\\xf0\\x9f\\x90\\xa4"),
			want:  "🐤",
		},
		// https://github.com/awilliams/wifi-presence/issues/7
		{
			name:  "mixed",
			input: []byte("\\xcf\\x89=2\\xcf\\x80f"),
			want:  "ω=2πf",
		},
		{
			name:  "quote",
			input: []byte("q\\\""),
			want:  "q\"",
		},
		{
			name:  "esc",
			input: []byte("esc\\\\"),
			want:  "esc\\",
		},
		{
			name:  "control",
			input: []byte("control\\e"),
			want:  "control\033",
		},
		{
			name:  "newline",
			input: []byte("new\\n"),
			want:  "new\n",
		},
		{
			name:  "carriage",
			input: []byte("car\\r"),
			want:  "car\r",
		},
		{
			name:  "tab",
			input: []byte("tab\\t"),
			want:  "tab\t",
		},
		{
			name:  "all",
			input: []byte("\\t\\xe2\\x9c\\xa8test\\n"),
			want:  "\t✨test\n",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := decodeSSID(tc.input)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
			t.Logf("got: %q", got)
		})
	}
}
