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

static NSData *TLOfflineStatus(void) {
    uint32_t w[2] = {kUpdateStatus, kBoolTrue};
    return [NSData dataWithBytes:w length:8];
}
static NSData *TLEmptyReadContents(void) {
    uint32_t w[3] = {kReadContents, kVector, 0};
    return [NSData dataWithBytes:w length:12];
}

static NSData *HBRewrite(NSData *payload) {
    if (payload.length < 4 || !HBOn(@"ghost", YES)) return nil;
    uint32_t ctor = 0;
    [payload getBytes:&ctor length:4];
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
