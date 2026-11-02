// HBoltTweak — runtime patch loaded into the official Telegram-iOS binary.
//  1. Storage fallback: if the App Group container is unavailable (re-signed
//     with a different team / bundle id), return a private folder instead of
//     nil so Telegram boots instead of showing a white screen / "Error 2".
//  2. Ghost mode at the MTProto layer: outgoing requests are rewritten (never
//     dropped, so the network layer always gets a well-typed reply):
//       account.updateStatus      -> offline = true          (hide online)
//       messages.setTyping        -> account.updateStatus(offline)
//       messages.readHistory      -> messages.readMessageContents([])  (no blue ticks)
//       channels.readHistory      -> account.updateStatus(offline)
//       messages/channels.readMessageContents -> empty / updateStatus
//       stories.readStories       -> max_id = 0              (no story views)
//       stories.incrementStoryViews -> account.updateStatus(offline)
//  3. Settings: shake the phone to open the HBolt menu (per-feature toggles).
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <Security/Security.h>

#pragma mark - Diagnostics (shown on screen if launch stalls)
static NSMutableArray<NSString *> *gDiag;
static void HBLog(NSString *fmt, ...) NS_FORMAT_FUNCTION(1, 2);
static void HBLog(NSString *fmt, ...) {
    va_list a; va_start(a, fmt);
    NSString *line = [[NSString alloc] initWithFormat:fmt arguments:a];
    va_end(a);
    NSLog(@"[HBolt] %@", line);
    @synchronized([NSProcessInfo class]) {
        if (!gDiag) gDiag = [NSMutableArray array];
        if (gDiag.count < 60) [gDiag addObject:line];
    }
}

#pragma mark - Keychain: drop access groups the re-signed app isn't entitled to
static CFDictionaryRef HBStripGroup(CFDictionaryRef q) {
    if (!q || !CFDictionaryContainsKey(q, kSecAttrAccessGroup)) return q ? CFRetain(q) : NULL;
    CFMutableDictionaryRef m = CFDictionaryCreateMutableCopy(NULL, 0, q);
    CFDictionaryRemoveValue(m, kSecAttrAccessGroup);
    return m;
}
static OSStatus hb_SecItemCopyMatching(CFDictionaryRef q, CFTypeRef *r) {
    CFDictionaryRef s = HBStripGroup(q); OSStatus st = SecItemCopyMatching(s, r); if (s) CFRelease(s);
    if (st != errSecSuccess && st != errSecItemNotFound) HBLog(@"keychain copy err %d", (int)st);
    return st;
}
static OSStatus hb_SecItemAdd(CFDictionaryRef q, CFTypeRef *r) {
    CFDictionaryRef s = HBStripGroup(q); OSStatus st = SecItemAdd(s, r); if (s) CFRelease(s);
    if (st != errSecSuccess) HBLog(@"keychain add err %d", (int)st);
    return st;
}
static OSStatus hb_SecItemUpdate(CFDictionaryRef q, CFDictionaryRef u) {
    CFDictionaryRef s = HBStripGroup(q); OSStatus st = SecItemUpdate(s, u); if (s) CFRelease(s);
    if (st != errSecSuccess && st != errSecItemNotFound) HBLog(@"keychain update err %d", (int)st);
    return st;
}
static OSStatus hb_SecItemDelete(CFDictionaryRef q) {
    CFDictionaryRef s = HBStripGroup(q); OSStatus st = SecItemDelete(s); if (s) CFRelease(s);
    return st;
}
// dyld interposing (applies to every image loaded at launch).
typedef struct { const void *replacement; const void *original; } hb_interpose_t;
__attribute__((used)) static const hb_interpose_t hb_interposers[] __attribute__((section("__DATA,__interpose"))) = {
    { (const void *)hb_SecItemCopyMatching, (const void *)SecItemCopyMatching },
    { (const void *)hb_SecItemAdd, (const void *)SecItemAdd },
    { (const void *)hb_SecItemUpdate, (const void *)SecItemUpdate },
    { (const void *)hb_SecItemDelete, (const void *)SecItemDelete },
};

static NSString *const kPrefix = @"hbolt.";
static BOOL HBOn(NSString *k, BOOL def) {
    id v = [[NSUserDefaults standardUserDefaults] objectForKey:[kPrefix stringByAppendingString:k]];
    return v ? [v boolValue] : def;
}
static void HBSet(NSString *k, BOOL on) {
    [[NSUserDefaults standardUserDefaults] setBool:on forKey:[kPrefix stringByAppendingString:k]];
}

#pragma mark - TL helpers
static const uint32_t kUpdateStatus = 0x6628562c, kSetTyping = 0x58943ee2, kReadHistory = 0x0e306d3a,
    kChReadHistory = 0xcc104937, kReadContents = 0x36a73f77, kChReadContents = 0xeab5dc38,
    kReadStories = 0xa556dac8, kIncStoryViews = 0xb2028afb, kBoolTrue = 0x997275b5, kVector = 0x1cb5c415;

static const uint32_t kAuthSendCode = 0xa677244f, kCodeSettings = 0xad253d78;
// Skip a TL-serialized string/bytes at `off`; returns the offset after it or 0 on error.
static NSUInteger TLSkipString(const uint8_t *b, NSUInteger len, NSUInteger off) {
    if (off >= len) return 0;
    NSUInteger n, head;
    if (b[off] < 254) { n = b[off]; head = 1; }
    else { if (off + 4 > len) return 0; n = b[off + 1] | (b[off + 2] << 8) | (b[off + 3] << 16); head = 4; }
    NSUInteger total = head + n;
    total = (total + 3) & ~(NSUInteger)3;
    return off + total <= len ? off + total : 0;
}
// auth.sendCode from a re-signed official binary asks Telegram to verify the
// app via a silent push to *Telegram's own* bundle id, which can never reach
// this app -> the request times out ("check your internet connection").
// Re-declare the client capabilities with plain CodeSettings (no push/firebase
// verification) so Telegram sends the code in-app / by SMS like any other client.
static NSData *HBFixSendCode(NSData *payload) {
    const uint8_t *b = payload.bytes; NSUInteger len = payload.length;
    NSUInteger off = TLSkipString(b, len, 4);          // phone_number
    if (!off || off + 4 > len) return nil;
    off += 4;                                           // api_id
    off = TLSkipString(b, len, off);                    // api_hash
    if (!off || off + 4 > len) return nil;
    uint32_t ctor; memcpy(&ctor, b + off, 4);
    if (ctor != kCodeSettings) return nil;
    NSMutableData *m = [NSMutableData dataWithBytes:b length:off];
    uint32_t tail[2] = {kCodeSettings, 0};
    [m appendBytes:tail length:8];
    HBLog(@"auth.sendCode: plain CodeSettings");
    return m;
}

static NSData *TLOfflineStatus(void) {
    uint32_t w[2] = {kUpdateStatus, kBoolTrue};
    return [NSData dataWithBytes:w length:8];
}
static NSData *TLEmptyReadContents(void) {
    uint32_t w[3] = {kReadContents, kVector, 0};
    return [NSData dataWithBytes:w length:12];
}

static NSData *HBRewrite(NSData *payload) {
    if (payload.length < 4) return nil;
    uint32_t ctor = 0;
    [payload getBytes:&ctor length:4];
    if (ctor == kAuthSendCode) return HBOn(@"fix.login", YES) ? HBFixSendCode(payload) : nil;
    if (!HBOn(@"ghost", YES)) return nil;
    switch (ctor) {
        case kUpdateStatus:
            return HBOn(@"ghost.online", YES) ? TLOfflineStatus() : nil;
        case kSetTyping:
            return HBOn(@"ghost.typing", YES) ? TLOfflineStatus() : nil;
        case kReadHistory:
            return HBOn(@"ghost.read", YES) ? TLEmptyReadContents() : nil;
        case kChReadHistory:
        case kChReadContents:
            return HBOn(@"ghost.read", YES) ? TLOfflineStatus() : nil;
        case kReadContents:
            return HBOn(@"ghost.read", YES) ? TLEmptyReadContents() : nil;
        case kReadStories: {
            if (!HBOn(@"ghost.stories", YES) || payload.length < 8) return nil;
            NSMutableData *m = [payload mutableCopy];
            uint32_t zero = 0;
            [m replaceBytesInRange:NSMakeRange(m.length - 4, 4) withBytes:&zero]; // max_id is the last field
            return m;
        }
        case kIncStoryViews:
            return HBOn(@"ghost.stories", YES) ? TLOfflineStatus() : nil;
        default:
            return nil;
    }
}

#pragma mark - MTRequest hook
static IMP gOrigSetPayload;
static void HB_setPayload(id self, SEL _cmd, NSData *payload, id metadata, id shortMetadata, id parser) {
    NSData *rewritten = HBRewrite(payload);
    ((void (*)(id, SEL, NSData *, id, id, id))gOrigSetPayload)(self, _cmd, rewritten ?: payload, metadata, shortMetadata, parser);
}

#pragma mark - App Group storage fallback
static IMP gOrigContainer;
static NSURL *HB_container(id self, SEL _cmd, NSString *groupId) {
    NSURL *url = ((NSURL * (*)(id, SEL, NSString *))gOrigContainer)(self, _cmd, groupId);
    if (url) { HBLog(@"group ok %@", groupId); return url; }
    HBLog(@"group FALLBACK %@", groupId);
    NSURL *lib = [[NSFileManager defaultManager] URLsForDirectory:NSLibraryDirectory inDomains:NSUserDomainMask].firstObject;
    NSURL *fallback = [[lib URLByAppendingPathComponent:@"HBoltAppGroup" isDirectory:YES] URLByAppendingPathComponent:groupId ?: @"default" isDirectory:YES];
    [[NSFileManager defaultManager] createDirectoryAtURL:fallback withIntermediateDirectories:YES attributes:nil error:nil];
    return fallback;
}

#pragma mark - Shake menu
@interface UIWindow (HBolt)
@end
@implementation UIWindow (HBolt)
- (void)hb_motionEnded:(UIEventSubtype)motion withEvent:(UIEvent *)event {
    [self hb_motionEnded:motion withEvent:event];
    if (motion != UIEventSubtypeMotionShake) return;
    UIViewController *top = self.rootViewController;
    while (top.presentedViewController) top = top.presentedViewController;
    if ([top isKindOfClass:[UIAlertController class]]) return;
    NSArray *items = @[ @[@"ghost", @"👻 وضع الشبح (الكل)"], @[@"ghost.read", @"عدم إرسال القراءة"], @[@"ghost.online", @"إخفاء متصل الآن"],
                        @[@"ghost.typing", @"إخفاء يكتب…"], @[@"ghost.stories", @"مشاهدة الستوري سرًا"] ];
    UIAlertController *a = [UIAlertController alertControllerWithTitle:@"HBolt"
                                                               message:@"دوس على أي خيار لتشغيله أو إيقافه.\nالتغييرات بتشتغل فورًا."
                                                        preferredStyle:UIAlertControllerStyleActionSheet];
    for (NSArray *it in items) {
        NSString *key = it[0];
        BOOL on = HBOn(key, YES);
        [a addAction:[UIAlertAction actionWithTitle:[NSString stringWithFormat:@"%@ %@", on ? @"✅" : @"⬜️", it[1]]
                                              style:UIAlertActionStyleDefault
                                            handler:^(UIAlertAction *x) { HBSet(key, !on); }]];
    }
    [a addAction:[UIAlertAction actionWithTitle:@"إغلاق" style:UIAlertActionStyleCancel handler:nil]];
    a.popoverPresentationController.sourceView = top.view;
    a.popoverPresentationController.sourceRect = CGRectMake(CGRectGetMidX(top.view.bounds), CGRectGetMidY(top.view.bounds), 1, 1);
    [top presentViewController:a animated:YES completion:nil];
}
@end

static void HBUncaught(NSException *e) {
    HBLog(@"EXCEPTION %@: %@", e.name, e.reason);
    [[gDiag componentsJoinedByString:@"\n"] writeToFile:[NSTemporaryDirectory() stringByAppendingPathComponent:@"hbolt-crash.txt"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

static UIWindow *HBKeyWindow(void) {
    for (UIScene *sc in UIApplication.sharedApplication.connectedScenes)
        if ([sc isKindOfClass:[UIWindowScene class]])
            for (UIWindow *w in ((UIWindowScene *)sc).windows) if (w.isKeyWindow) return w;
    return UIApplication.sharedApplication.windows.firstObject;
}

static void HBMaybeShowDiag(void) {
    UIWindow *w = HBKeyWindow();
    UIViewController *root = w.rootViewController;
    BOOL blank = !w || !root || root.view.subviews.count == 0 || w.hidden;
    NSString *prev = [NSString stringWithContentsOfFile:[NSTemporaryDirectory() stringByAppendingPathComponent:@"hbolt-crash.txt"] encoding:NSUTF8StringEncoding error:nil];
    HBLog(@"window=%@ root=%@ subviews=%lu", w ? @"yes" : @"no", NSStringFromClass(root.class), (unsigned long)root.view.subviews.count);
    if (!blank && !prev) return;
    NSString *report = [NSString stringWithFormat:@"%@%@", prev ? [@"آخر كراش:\n" stringByAppendingString:prev] : @"", [gDiag componentsJoinedByString:@"\n"]];
    UIPasteboard.generalPasteboard.string = report;
    UIWindow *dw = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)UIApplication.sharedApplication.connectedScenes.anyObject];
    dw.windowLevel = UIWindowLevelAlert + 1;
    UIViewController *vc = [UIViewController new];
    dw.rootViewController = vc;
    [dw makeKeyAndVisible];
    objc_setAssociatedObject(UIApplication.sharedApplication, "hbdiag", dw, OBJC_ASSOCIATION_RETAIN);
    UIAlertController *a = [UIAlertController alertControllerWithTitle:@"HBolt — تقرير التشغيل" message:[report stringByAppendingString:@"\n\n(اتنسخ — ابعته)"] preferredStyle:UIAlertControllerStyleAlert];
    [a addAction:[UIAlertAction actionWithTitle:@"تمام" style:UIAlertActionStyleCancel handler:nil]];
    [vc presentViewController:a animated:YES completion:nil];
}

#pragma mark - CloudKit: the re-signed app has no iCloud entitlement, and
// CloudKit throws an NSException ("no CloudKit entitlement") the moment
// Telegram asks for a container -> instant crash. Hand back an inert proxy
// instead: every message to it is swallowed and returns 0/nil, so Telegram's
// optional iCloud features simply never complete.
@interface HBInertCK : NSProxy
@end
@implementation HBInertCK
+ (instancetype)shared { static HBInertCK *s; static dispatch_once_t o; dispatch_once(&o, ^{ s = [HBInertCK alloc]; }); return s; }
- (NSMethodSignature *)methodSignatureForSelector:(SEL)sel {
    Class ck = objc_getClass("CKContainer");
    NSMethodSignature *sig = ck ? [ck instanceMethodSignatureForSelector:sel] : nil;
    if (!sig) { Class db = objc_getClass("CKDatabase"); sig = db ? [db instanceMethodSignatureForSelector:sel] : nil; }
    return sig ?: [NSObject instanceMethodSignatureForSelector:@selector(description)];
}
- (void)forwardInvocation:(NSInvocation *)inv {
    NSUInteger len = inv.methodSignature.methodReturnLength;
    if (len) { void *zero = calloc(1, len); [inv setReturnValue:zero]; free(zero); }
}
- (BOOL)respondsToSelector:(SEL)s { return YES; }
- (NSString *)description { return @"<HBInertCKContainer>"; }
@end
static id HB_ckDefault(id cls, SEL _cmd) { HBLog(@"CloudKit defaultContainer -> inert"); return [HBInertCK shared]; }
static id HB_ckWithId(id cls, SEL _cmd, NSString *ident) { HBLog(@"CloudKit container %@ -> inert", ident); return [HBInertCK shared]; }
static void HBNeuterCloudKit(void) {
    Class ck = objc_getClass("CKContainer");
    if (!ck) return;
    Method m1 = class_getClassMethod(ck, @selector(defaultContainer));
    Method m2 = class_getClassMethod(ck, NSSelectorFromString(@"containerWithIdentifier:"));
    if (m1) method_setImplementation(m1, (IMP)HB_ckDefault);
    if (m2) method_setImplementation(m2, (IMP)HB_ckWithId);
    Method i1 = class_getInstanceMethod(ck, NSSelectorFromString(@"initWithContainerIdentifier:"));
    if (i1) method_setImplementation(i1, (IMP)HB_ckWithId);
}

static void HBSwizzle(Class c, SEL orig, SEL repl) {
    Method o = class_getInstanceMethod(c, orig), r = class_getInstanceMethod(c, repl);
    if (!o || !r) return;
    if (class_addMethod(c, orig, method_getImplementation(r), method_getTypeEncoding(r)))
        class_replaceMethod(c, repl, method_getImplementation(o), method_getTypeEncoding(o));
    else
        method_exchangeImplementations(o, r);
}

static void HBInstallNetworkHook(void) {
    static BOOL done = NO;
    if (done) return;
    Class req = objc_getClass("MTRequest");
    SEL sel = NSSelectorFromString(@"setPayload:metadata:shortMetadata:responseParser:");
    Method m = req ? class_getInstanceMethod(req, sel) : NULL;
    if (!m) return;
    gOrigSetPayload = method_setImplementation(m, (IMP)HB_setPayload);
    done = YES;
    HBLog(@"MTRequest hook installed");
}

__attribute__((constructor)) static void HBoltInit(void) {
    Method c = class_getInstanceMethod([NSFileManager class], @selector(containerURLForSecurityApplicationGroupIdentifier:));
    if (c) gOrigContainer = method_setImplementation(c, (IMP)HB_container);
    HBSwizzle([UIWindow class], @selector(motionEnded:withEvent:), @selector(hb_motionEnded:withEvent:));
    HBNeuterCloudKit();
    HBInstallNetworkHook();
    HBLog(@"bundle %@ v%@", NSBundle.mainBundle.bundleIdentifier, [NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"]);
    NSSetUncaughtExceptionHandler(&HBUncaught);
    [[NSNotificationCenter defaultCenter] addObserverForName:UIApplicationDidFinishLaunchingNotification object:nil queue:nil
                                                  usingBlock:^(NSNotification *n) {
        HBInstallNetworkHook();
        HBLog(@"didFinishLaunching");
        // If the UI is still blank after 10 s, show what happened so it can be fixed.
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ HBMaybeShowDiag(); });
    }];
}
